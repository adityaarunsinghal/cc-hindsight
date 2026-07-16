import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { type LibraryIssue, readLibrary, readLibraryIssues } from "../core/library.js";
import { loadDigests, loadTasks, summarizeOutcomes } from "../distill/pipeline.js";
import { parseSourceMode, resolveSources, type SourceMode } from "../sources/registry.js";
import { bold, dim, green, hint, yellow } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import type { ManifestEntry } from "./distill.js";

/** Render the "unreadable library entries" warning block; empty when clean. */
function renderLibraryIssues(issues: LibraryIssue[]): string[] {
  if (issues.length === 0) return [];
  const lines = [
    "",
    yellow(
      `${issues.length} unreadable librar${issues.length === 1 ? "y entry" : "y entries"} (skipped — fix or remove):`,
    ),
  ];
  for (const issue of issues) {
    lines.push(`  ⚠ ${issue.slug} ${dim(`(${issue.reason})`)}`);
  }
  return lines;
}

/** Render the "stale digest checkpoint keys" warning block; empty when clean. */
function renderStaleDigests(keys: string[]): string[] {
  if (keys.length === 0) return [];
  const lines = [
    "",
    yellow(
      `${keys.length} digested session(s) no longer in the manifest (deleted/renamed — --fresh to clear):`,
    ),
  ];
  for (const key of keys) {
    lines.push(`  ⚠ ${dim(key)}`);
  }
  return lines;
}

/** Build the status report: the funnel, per-task marks, orphans, skipped tasks. */
export function renderStatus(opts: {
  home: string;
  claudeDir: string;
  kiroDir?: string;
  source?: SourceMode;
}): string {
  const lines: string[] = [];

  // discovered — sum over every active backend; tolerate missing stores.
  let discovered: number | null = null;
  try {
    const mode = opts.source ?? "auto";
    const kiroDir = opts.kiroDir ?? path.join(process.env.HOME ?? "", ".kiro");
    const sources = resolveSources(mode, { claudeDir: opts.claudeDir, kiroDir });
    discovered = sources.reduce(
      (n, src) =>
        n + src.discover({ countEntries: false }).reduce((m, p) => m + p.sessions.length, 0),
      0,
    );
  } catch {
    discovered = null;
  }

  let exported = 0;
  const manifestExports = new Set<string>();
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(opts.home, "exports", "manifest.json"), "utf8"),
    ) as ManifestEntry[];
    if (Array.isArray(manifest)) {
      exported = manifest.length;
      for (const e of manifest) if (e?.export) manifestExports.add(e.export);
    }
  } catch {
    // nothing exported yet
  }

  const digests = loadDigests(opts.home);
  const tasks = loadTasks(opts.home);
  const library = readLibrary(opts.home);
  const libraryIssues = readLibraryIssues(opts.home);
  const digested = digests ? Object.keys(digests.digests).length : 0;

  // Digest-checkpoint keys whose export is gone from the manifest (a session
  // deleted/renamed since it was digested) — stale, flagged for cleanup.
  const staleDigestKeys =
    digests && manifestExports.size > 0
      ? Object.keys(digests.digests).filter((k) => !manifestExports.has(k))
      : [];

  lines.push(
    `discovered  ${bold(String(discovered ?? "?"))} session(s)${discovered === null ? " (claude dir not found)" : ""}`,
    `exported    ${bold(String(exported))} session(s)`,
    `digested    ${bold(String(digested))} session(s)${digests ? dim(`  (generation ${digests.generation})`) : ""}`,
  );

  if (!tasks) {
    lines.push("clustered   —");
    lines.push("authored    —");
    lines.push(...renderStaleDigests(staleDigestKeys));
    lines.push(...renderLibraryIssues(libraryIssues));
    lines.push("");
    lines.push(hint(exported === 0 ? "cc-hindsight export" : "cc-hindsight distill"));
    return lines.join("\n");
  }

  lines.push(
    `clustered   ${bold(String(tasks.tasks.length))} task(s), ${tasks.misc.length} in misc` +
      dim(`  (generation ${tasks.generation})`),
  );

  const bySlug = new Map(library.map((e) => [e.slug, e]));
  const currentSlugs = new Set(tasks.tasks.map((t) => t.slug));
  // "authored" = entries for a CURRENT task, authored in the current generation.
  // Requiring the slug to still be in tasks.json stops a zombie (a slug dropped
  // by same-generation re-clustering) from inflating the count.
  const current = library.filter(
    (e) => currentSlugs.has(e.slug) && e.sources.generation === tasks.generation,
  );
  lines.push(`authored    ${bold(String(current.length))} of ${tasks.tasks.length} task(s)`);

  for (const task of tasks.tasks) {
    const entry = bySlug.get(task.slug);
    if (entry && entry.sources.generation === tasks.generation) {
      lines.push(`  ${green("✓")} ${task.slug}`);
    } else {
      // Not authored in this generation: was it skipped (no successful
      // member) or is it simply pending?
      const outcomes = digests ? summarizeOutcomes(task.members, digests.digests) : "";
      const viable = task.members.some((m) => {
        const o = digests?.digests[m]?.outcome;
        return o === "completed" || o === "partial";
      });
      if (!viable) {
        lines.push(`  · ${task.slug} ${yellow(`skipped (no successful sessions: ${outcomes})`)}`);
      } else {
        lines.push(`  · ${task.slug} ${dim("pending — run cc-hindsight distill")}`);
      }
    }
  }

  // Orphans: library entries with no matching current task. Covers BOTH the
  // stale-generation case (e.g. after --fresh) AND same-generation zombies —
  // a slug dropped when re-clustering merged or renamed tasks, which keeps the
  // current generation id and so would pass a generation-only check.
  const orphans = library.filter(
    (e) => !currentSlugs.has(e.slug) || e.sources.generation !== tasks.generation,
  );
  if (orphans.length > 0) {
    lines.push("");
    lines.push(
      yellow(
        `${orphans.length} orphaned librar${orphans.length === 1 ? "y entry" : "y entries"} (re-clustering left them behind):`,
      ),
    );
    for (const o of orphans) {
      lines.push(`  ⚠ ${o.slug} ${dim(`(generation ${o.sources.generation})`)}`);
    }
  }

  lines.push(...renderStaleDigests(staleDigestKeys));
  lines.push(...renderLibraryIssues(libraryIssues));
  lines.push("");
  lines.push(hint(current.length > 0 ? "cc-hindsight list" : "cc-hindsight distill"));
  return lines.join("\n");
}

export default defineCommand({
  meta: {
    name: "status",
    description: "Pipeline funnel: discovered → exported → digested → clustered → authored",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home, claudeDir, kiroDir } = resolvePaths(args);
    console.log(
      renderStatus({ home, claudeDir, kiroDir, source: parseSourceMode(args.source as string) }),
    );
  },
});
