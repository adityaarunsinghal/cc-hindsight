import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { findEntry, isEdited } from "../core/library.js";
import { dim, green, hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/**
 * commands/edit.ts — open a oneshot in the user's editor.
 *
 * The library is the user's, not the tool's: hand-tuning an authored prompt is
 * the expected workflow. Edits are detected by hash mismatch against the
 * `oneshot_hash` recorded at author time — an edited entry is badged in `list`
 * and never overwritten by a re-run of `distill` without `--force`.
 */

export interface EditArgs {
  home?: string;
  "claude-dir"?: string;
  slug?: string;
}

export interface EditDeps {
  /** Injectable editor launcher (default: $VISUAL/$EDITOR/vi via spawnSync). */
  launch?: (file: string) => number;
  output?: Writable;
}

function defaultLaunch(file: string): number {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  // Support multi-word values like "code --wait" by splitting on whitespace;
  // no shell is involved, and the file path is passed as a discrete argument
  // (never interpolated), so paths with spaces or metacharacters are safe.
  const [cmd = "vi", ...editorArgs] = editor.split(/\s+/).filter(Boolean);
  const res = spawnSync(cmd, [...editorArgs, file], { stdio: "inherit" });
  return res.status ?? 1;
}

/** Testable core of `edit`. Returns the process exit code. */
export function runEdit(args: EditArgs, deps: EditDeps = {}): number {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);
  const launch = deps.launch ?? defaultLaunch;

  const slug = String(args.slug ?? "");
  const entry = findEntry(home, slug);
  if (!entry) {
    write(`no library entry "${slug}" — try \`cc-hindsight list\`.`);
    return 1;
  }
  if (!fs.existsSync(entry.oneshotPath)) {
    write(`entry "${slug}" has no oneshot file (${entry.oneshotPath}).`);
    return 1;
  }

  const status = launch(entry.oneshotPath);
  if (status !== 0) {
    write(`editor exited with status ${status}; file left as-is.`);
    return 1;
  }

  // Re-read to report whether the entry is now (or still) hand-edited.
  const fresh = findEntry(home, slug);
  if (fresh && isEdited(fresh)) {
    write(green(`✎ ${slug} edited — distill will keep your version (use --force to re-author).`));
  } else {
    write(dim(`${slug} unchanged.`));
  }
  write(hint(`cc-hindsight show ${slug}`));
  return 0;
}

export default defineCommand({
  meta: {
    name: "edit",
    description: "Open a oneshot in your editor ($VISUAL/$EDITOR); edits are protected",
  },
  args: {
    ...sharedArgs,
    slug: {
      type: "positional",
      description: "Library entry slug",
      required: true,
    },
  },
  run({ args }) {
    const code = runEdit(args as unknown as EditArgs);
    if (code !== 0) process.exitCode = code;
  },
});
