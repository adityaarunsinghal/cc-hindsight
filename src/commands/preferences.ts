import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { askYesNo } from "../claude/consent.js";
import { type Consolidated, ConsolidateSchema } from "../claude/schemas.js";
import { readLibrary } from "../core/library.js";
import {
  type AggregatedPreference,
  aggregatePreferences,
  renderClaudeMdBlock,
} from "../core/preferences.js";
import type { RunnerFn } from "../distill/pipeline.js";
import { withSpinner } from "../ui/progress.js";
import { cyan, dim, green, hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** Injectable dependencies (testing). */
export interface PreferencesDeps {
  runner?: RunnerFn;
  input?: Readable;
  output?: Writable;
}

/** Build the one-call consolidation prompt (merge duplicates, tighten wording). */
export function buildConsolidatePrompt(prefs: AggregatedPreference[]): string {
  return [
    "Below are working preferences extracted from a developer's prompt history,",
    "with how many tasks stated each. Merge semantic duplicates and tighten the",
    "wording. Keep every distinct preference; never invent new ones. Keep each",
    "item a single imperative line in the author's plain register.",
    "",
    'Respond with JSON: {"preferences": [{"text", "merged_from"}]} where',
    '"merged_from" is how many input lines the item covers.',
    "",
    "=== PREFERENCES ===",
    ...prefs.map((p) => `- ${p.text} (stated in ${p.count} task(s))`),
    "=== END PREFERENCES ===",
  ].join("\n");
}

/** The preferences command core; returns the intended exit code. */
export async function runPreferences(
  args: {
    home?: string;
    "claude-dir"?: string;
    consolidate?: boolean;
    yes?: boolean;
    model?: string;
  },
  deps: PreferencesDeps = {},
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);

  const { home } = resolvePaths(args);
  const entries = readLibrary(home);
  if (entries.length === 0) {
    write("library is empty — nothing distilled yet.");
    write(hint("cc-hindsight distill"));
    return 1;
  }

  const prefs = aggregatePreferences(entries);
  if (prefs.length === 0) {
    write("no preferences were observed across the library.");
    return 0;
  }

  const recurring = prefs.filter((p) => p.count > 1).length;
  write(
    green(`${prefs.length} preference(s) across ${entries.length} task(s)`) +
      (recurring ? cyan(` (${recurring} recur)`) : ""),
  );
  write();

  if (!args.consolidate) {
    write(renderClaudeMdBlock(prefs, entries.length));
    write();
    write(dim("paste the block into your CLAUDE.md — or run with --consolidate"));
    write(dim("to merge near-duplicates with one claude call."));
    return 0;
  }

  // --consolidate: one claude call, behind the same consent gate as distill.
  write("consolidate will invoke your local `claude` CLI once (your subscription/credits).");
  const confirmed =
    Boolean(args.yes) || (await askYesNo("Proceed?", { input: deps.input, output: deps.output }));
  if (!confirmed) {
    write("declined; nothing was invoked.");
    return 2;
  }

  const { runClaude } = await import("../claude/runner.js");
  const runner: RunnerFn = deps.runner ?? runClaude;
  let consolidated: Consolidated;
  try {
    consolidated = await withSpinner(out, `consolidating ${prefs.length} preference(s)`, () =>
      runner({
        prompt: buildConsolidatePrompt(prefs),
        schema: ConsolidateSchema,
        model: args.model,
      }),
    );
  } catch (err) {
    // Real-world case: the account's default model can be rejected by policy
    // (e.g. Bedrock data-retention 400s) — fail with the reason, not a stack,
    // and still emit the deterministic block so the run yields a usable artifact.
    write(`consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
    write(dim("falling back to the unconsolidated block; retry with --model <model>."));
    write();
    write(renderClaudeMdBlock(prefs, entries.length));
    return 1;
  }

  const merged: AggregatedPreference[] = consolidated.preferences.map((p) => ({
    text: p.text,
    count: p.merged_from,
    occurrences: [],
    lastAuthoredAt: "",
  }));
  write();
  write(renderClaudeMdBlock(merged, entries.length));
  write();
  write(dim(`consolidated ${prefs.length} → ${merged.length} preference(s).`));
  return 0;
}

export default defineCommand({
  meta: {
    name: "preferences",
    description: "Aggregate recurring preferences into a CLAUDE.md snippet",
  },
  args: {
    ...sharedArgs,
    consolidate: {
      type: "boolean",
      description: "Merge semantic duplicates with one claude call (consent-gated)",
    },
    model: {
      type: "string",
      description: "Model to pass through to `claude --model` for --consolidate",
    },
    yes: { type: "boolean", description: "Skip the consent prompt (for scripting)" },
  },
  async run({ args }) {
    const code = await runPreferences(args);
    if (code !== 0) process.exitCode = code;
  },
});
