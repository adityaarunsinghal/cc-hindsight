import fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { askYesNo } from "../claude/consent.js";
import { isEdited, readLibrary } from "../core/library.js";
import { loadTasks } from "../distill/pipeline.js";
import { dim, green, hint, yellow } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/**
 * commands/prune.ts — delete orphaned library entries.
 *
 * An orphan is what `status` flags: an entry whose slug is no longer in the
 * current tasks checkpoint, or whose generation doesn't match it (re-clustering
 * merged, renamed, or regenerated its task). Deletion is destructive, so it is
 * consent-gated ([y/N], `--yes` to skip) and hand-edited entries are kept
 * unless `--force` — the same protection `distill` gives them.
 */

export interface PruneArgs {
  home?: string;
  "claude-dir"?: string;
  yes?: boolean;
  force?: boolean;
  "dry-run"?: boolean;
}

export interface PruneDeps {
  input?: Readable;
  output?: Writable;
}

/** Testable core of `prune`. Returns the process exit code (2 = declined). */
export async function runPrune(args: PruneArgs, deps: PruneDeps = {}): Promise<number> {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const tasks = loadTasks(home);
  if (!tasks) {
    write("no distill checkpoint — cannot tell orphans from current entries.");
    write(hint("cc-hindsight status"));
    return 1;
  }

  const currentSlugs = new Set(tasks.tasks.map((t) => t.slug));
  const orphans = readLibrary(home).filter(
    (e) => !currentSlugs.has(e.slug) || e.sources.generation !== tasks.generation,
  );
  if (orphans.length === 0) {
    write(green("no orphaned entries — library is clean."));
    return 0;
  }

  // Hand-edited orphans are the user's work; keep them unless --force.
  const kept = args.force ? [] : orphans.filter((e) => isEdited(e));
  const removable = orphans.filter((e) => !kept.includes(e));

  write(`${orphans.length} orphaned librar${orphans.length === 1 ? "y entry" : "y entries"}:`);
  for (const e of removable) write(`  ✗ ${e.slug} ${dim(`(generation ${e.sources.generation})`)}`);
  for (const e of kept) write(`  ✋ ${e.slug} ${yellow("edited by hand — kept (use --force)")}`);

  if (removable.length === 0) {
    write(dim("nothing removable without --force."));
    return 0;
  }

  if (args["dry-run"]) {
    write(
      dim(`dry-run: would remove ${removable.length} entr${removable.length === 1 ? "y" : "ies"}.`),
    );
    return 0;
  }

  if (!args.yes) {
    const ok = await askYesNo(
      `Remove ${removable.length} orphaned entr${removable.length === 1 ? "y" : "ies"}?`,
      {
        input: deps.input,
        output: deps.output,
      },
    );
    if (!ok) {
      write("declined — nothing removed.");
      return 2;
    }
  }

  for (const e of removable) {
    fs.rmSync(e.dir, { recursive: true, force: true });
    write(`  removed ${e.slug}`);
  }
  write(green(`${removable.length} entr${removable.length === 1 ? "y" : "ies"} pruned.`));
  write(hint("cc-hindsight list"));
  return 0;
}

export default defineCommand({
  meta: {
    name: "prune",
    description: "Remove library entries orphaned by re-clustering (asks first)",
  },
  args: {
    ...sharedArgs,
    yes: { type: "boolean", description: "Skip the confirmation prompt" },
    force: { type: "boolean", description: "Also remove entries you edited by hand" },
    "dry-run": { type: "boolean", description: "List what would be removed; remove nothing" },
  },
  async run({ args }) {
    const code = await runPrune(args as unknown as PruneArgs);
    if (code !== 0) process.exitCode = code;
  },
});
