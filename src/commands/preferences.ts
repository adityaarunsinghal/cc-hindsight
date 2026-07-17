import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { askYesNo } from "../claude/consent.js";
import { type Consolidated, ConsolidateSchema } from "../claude/schemas.js";
import { readLibrary } from "../core/library.js";
import {
  type AggregatedPreference,
  aggregatePreferences,
  type PreferencesTarget,
  renderPreferencesBlock,
} from "../core/preferences.js";
import type { RunnerFn } from "../distill/pipeline.js";
import { parseRunnerMode, resolveRunner } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import { parseSourceMode } from "../sources/registry.js";
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
    "kiro-dir"?: string;
    source?: string;
    runner?: string;
    target?: string;
    consolidate?: boolean;
    yes?: boolean;
    model?: string;
  },
  deps: PreferencesDeps = {},
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);
  const target = resolveTarget(args.target, parseSourceMode(args.source));

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
    write(renderPreferencesBlock(prefs, entries.length, target));
    write();
    for (const line of targetFooter(target)) write(dim(line));
    return 0;
  }

  // --consolidate: one runner call, behind the same consent gate as distill.
  // Route through resolveRunner so a kiro-only machine works (and the copy names
  // whichever CLI will actually run); an explicit --runner with a missing
  // binary fails HERE, before the consent prompt. An injected deps.runner
  // (tests) bypasses it.
  const sourceMode = parseSourceMode(args.source);
  let resolved: AgentRunner | null = null;
  if (!deps.runner) {
    try {
      resolved = await resolveRunner(parseRunnerMode(args.runner), {
        preferSource: sourceMode === "auto" ? undefined : sourceMode,
        scratchBase: path.join(home, "runner-scratch"),
      });
    } catch (err) {
      write((err as Error).message);
      return 1;
    }
  }
  const cli = resolved?.name === "kiro" ? "kiro-cli" : "claude";
  const cost = resolved?.name === "kiro" ? "your Kiro credits" : "your subscription/credits";
  write(`consolidate will invoke your local \`${cli}\` CLI once (${cost}).`);
  const confirmed =
    Boolean(args.yes) || (await askYesNo("Proceed?", { input: deps.input, output: deps.output }));
  if (!confirmed) {
    write("declined; nothing was invoked.");
    return 2;
  }

  const runner: RunnerFn = deps.runner ?? (resolved as NonNullable<typeof resolved>).run;
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
    write(renderPreferencesBlock(prefs, entries.length, target));
    await resolved?.finalize?.();
    return 1;
  }
  // Once-per-run teardown (kiro: delete this run's auto-saved session).
  await resolved?.finalize?.();

  const merged: AggregatedPreference[] = consolidated.preferences.map((p) => ({
    text: p.text,
    count: p.merged_from,
    occurrences: [],
    lastAuthoredAt: "",
  }));
  write();
  write(renderPreferencesBlock(merged, entries.length, target));
  write();
  write(dim(`consolidated ${prefs.length} → ${merged.length} preference(s).`));
  return 0;
}

/**
 * Resolve the preferences target: explicit `--target`, else infer from the
 * active source (kiro source ⇒ kiro steering; else claude).
 */
function resolveTarget(
  raw: string | undefined,
  sourceMode: "claude" | "kiro" | "auto",
): PreferencesTarget {
  if (raw) {
    const v = raw.toLowerCase();
    if (v === "claude" || v === "kiro" || v === "agents") return v;
    throw new Error(`unknown --target "${raw}" (expected claude, kiro, or agents)`);
  }
  return sourceMode === "kiro" ? "kiro" : "claude";
}

/** Per-target paste instructions shown under the rendered block. */
function targetFooter(target: PreferencesTarget): string[] {
  switch (target) {
    case "kiro":
      return [
        "paste the block into ~/.kiro/steering/hindsight-preferences.md (global) or",
        ".kiro/steering/ (workspace) — or run with --consolidate to merge near-duplicates.",
      ];
    case "agents":
      return [
        "add the block to your AGENTS.md — kiro and other agent CLIs auto-inherit it.",
        "or run with --consolidate to merge near-duplicates with one runner call.",
      ];
    default:
      return [
        "paste the block into your CLAUDE.md — or run with --consolidate",
        "to merge near-duplicates with one runner call.",
      ];
  }
}

export default defineCommand({
  meta: {
    name: "preferences",
    description: "Aggregate recurring preferences into a CLAUDE.md / steering / AGENTS.md block",
  },
  args: {
    ...sharedArgs,
    target: {
      type: "string",
      description:
        "Output target: claude (CLAUDE.md), kiro (steering file), or agents (AGENTS.md). Default: inferred from --source",
    },
    consolidate: {
      type: "boolean",
      description: "Merge semantic duplicates with one runner call (consent-gated)",
    },
    runner: {
      type: "string",
      description: "Which local CLI consolidates: claude, kiro, or auto (default: auto)",
    },
    model: {
      type: "string",
      description: "Model to pass through to the runner's --model for --consolidate",
    },
    yes: { type: "boolean", description: "Skip the consent prompt (for scripting)" },
  },
  async run({ args }) {
    const code = await runPreferences(args);
    if (code !== 0) process.exitCode = code;
  },
});
