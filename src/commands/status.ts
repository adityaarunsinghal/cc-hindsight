import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { discoverProjects } from "../core/discover.js";
import { readLibrary } from "../core/library.js";
import { loadDigests, loadTasks, summarizeOutcomes } from "../distill/pipeline.js";
import { bold, dim, green, hint, yellow } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";
import type { ManifestEntry } from "./distill.js";

/** Build the status report (§5.2: the funnel, orphans, skipped tasks). */
export function renderStatus(opts: { home: string; claudeDir: string }): string {
  const lines: string[] = [];

  // discovered — tolerate a missing claude dir entirely.
  let discovered: number | null = null;
  try {
    discovered = discoverProjects(opts.claudeDir).reduce((n, p) => n + p.sessions.length, 0);
  } catch {
    discovered = null;
  }

  let exported = 0;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(opts.home, "exports", "manifest.json"), "utf8"),
    ) as ManifestEntry[];
    exported = Array.isArray(manifest) ? manifest.length : 0;
  } catch {
    // nothing exported yet
  }

  const digests = loadDigests(opts.home);
  const tasks = loadTasks(opts.home);
  const library = readLibrary(opts.home);
  const digested = digests ? Object.keys(digests.digests).length : 0;

  lines.push(
    `discovered  ${bold(String(discovered ?? "?"))} session(s)${discovered === null ? " (claude dir not found)" : ""}`,
    `exported    ${bold(String(exported))} session(s)`,
    `digested    ${bold(String(digested))} session(s)${digests ? dim(`  (generation ${digests.generation})`) : ""}`,
  );

  if (!tasks) {
    lines.push("clustered   —");
    lines.push("authored    —");
    lines.push("");
    lines.push(hint(exported === 0 ? "cc-hindsight export" : "cc-hindsight distill"));
    return lines.join("\n");
  }

  lines.push(
    `clustered   ${bold(String(tasks.tasks.length))} task(s), ${tasks.misc.length} in _misc` +
      dim(`  (generation ${tasks.generation})`),
  );

  const bySlug = new Map(library.map((e) => [e.slug, e]));
  const current = library.filter((e) => e.sources.generation === tasks.generation);
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

  // Orphans: library entries authored under a different generation (flaw 9).
  const orphans = library.filter((e) => e.sources.generation !== tasks.generation);
  if (orphans.length > 0) {
    lines.push("");
    lines.push(
      yellow(
        `${orphans.length} orphaned librar${orphans.length === 1 ? "y entry" : "y entries"} (stale generation — re-clustering left them behind):`,
      ),
    );
    for (const o of orphans) {
      lines.push(`  ⚠ ${o.slug} ${dim(`(generation ${o.sources.generation})`)}`);
    }
  }

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
    const { home, claudeDir } = resolvePaths(args);
    console.log(renderStatus({ home, claudeDir }));
  },
});
