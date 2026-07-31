import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import {
  askYesNo,
  type ConsentOptions,
  type ConsentResult,
  type DistillPlan,
  confirm as defaultConfirm,
} from "../claude/consent.js";
import type { Digest } from "../claude/schemas.js";
import { resolveInputBudget, resolveTimeoutMs, resolveTruncatePolicy } from "../core/budget.js";
import { readLibrary } from "../core/library.js";
import { aggregatePreferences } from "../core/preferences.js";
import {
  clearCheckpoints,
  loadDigests,
  type RunnerFn,
  runAuthorStage,
  runClusterStage,
  runDigestStage,
} from "../distill/pipeline.js";
import { parseRunnerMode, resolveRunner } from "../runners/registry.js";
import type { AgentRunner } from "../runners/types.js";
import { parseSourceMode } from "../sources/registry.js";
import type { SourceName } from "../sources/types.js";
import { renderLibraryTable } from "../ui/library-table.js";
import { banner, bold, cyan, dim, fail, green, hint, skip } from "../ui/style.js";
import { parseClampedInt, resolvePaths, sharedArgs } from "./_shared.js";
import { type ExportArgs, runExport } from "./export.js";
import { offerCopyBlock, resolveTarget, runConsolidation } from "./preferences.js";

// One entry of `exports/manifest.json` — defined next to the code that writes
// it; re-exported here because the distill plan is computed from it.
export type { ManifestEntry } from "./export.js";

import type { ManifestEntry } from "./export.js";

/** Normalized args the distill core reads. */
export interface DistillArgs {
  home?: string;
  "claude-dir"?: string;
  "kiro-dir"?: string;
  /** Which backend(s) to distill from: claude, kiro, or auto (default auto). */
  source?: string;
  /** Which local CLI distills: claude, kiro, or auto (default auto). */
  runner?: string;
  project?: string;
  /** citty maps `--no-group` to `group: false`; grouping is on by default. */
  group?: boolean;
  /**
   * citty maps `--no-breaker` to `breaker: false`. The systemic-failure breaker
   * is on by default; disabling it attempts every session even when they are all
   * failing identically.
   */
  breaker?: boolean;
  "min-substance"?: string;
  model?: string;
  fresh?: boolean;
  "dry-run"?: boolean;
  yes?: boolean;
  "input-budget"?: string;
  truncate?: string;
  timeout?: string;
  concurrency?: string;
  force?: boolean;
}

/** The count math derived from the manifest, before consent. */
export interface ComputedPlan {
  eligible: ManifestEntry[];
  digests: number;
  cluster: 0 | 1;
  authorEstimate: number;
}

/**
 * Compute the invocation plan from manifest entries: apply the `--project`
 * filter and `--min-substance` threshold, then derive digest / cluster /
 * author counts. Author estimate is `max(1, round(eligible/3))` when grouping
 * (exact count is only known after clustering), or exactly one per session
 * with `--no-group`.
 */
export function computePlan(
  entries: ManifestEntry[],
  inputs: {
    project?: string;
    minSubstance: number;
    noGroup: boolean;
    /** Origins to include; entries from other backends are filtered out. Absent ⇒ all. */
    activeOrigins?: Set<string>;
  },
): ComputedPlan {
  let eligible = entries;
  // Origin filter: a manifest written before the multi-backend seam has no
  // `origin` ⇒ treat as "claude" (the old-manifest rule).
  if (inputs.activeOrigins) {
    eligible = eligible.filter((e) => inputs.activeOrigins?.has(e.origin ?? "claude"));
  }
  if (inputs.project) {
    const needle = inputs.project.toLowerCase();
    eligible = eligible.filter((e) => (e.project ?? "").toLowerCase().includes(needle));
  }
  eligible = eligible.filter((e) => (e.messages ?? 0) >= inputs.minSubstance);

  const digests = eligible.length;
  const cluster: 0 | 1 = !inputs.noGroup && digests > 0 ? 1 : 0;
  let authorEstimate: number;
  if (digests === 0) authorEstimate = 0;
  else if (inputs.noGroup) authorEstimate = digests;
  else authorEstimate = Math.max(1, Math.round(digests / 3));

  return { eligible, digests, cluster, authorEstimate };
}

/**
 * Resume note for the consent block: when a digests checkpoint already holds
 * some (but not all) sessions, state how much is left. Best-effort — a missing
 * or malformed checkpoint simply yields no note.
 */
function computeResumeNote(home: string, plan: ComputedPlan, fresh: boolean): string | undefined {
  if (fresh) return undefined;
  try {
    const raw = fs.readFileSync(path.join(home, "distill", "digests.json"), "utf8");
    const data = JSON.parse(raw) as { digests?: Record<string, unknown> };
    // Count only checkpoint entries that are ALSO in the currently eligible set.
    // Without this intersection, digesting project A then running `--project B`
    // would report "2 of 4 done" while all 4 of B actually run — a lie in a
    // block that is otherwise a byte-pinned contract.
    const doneKeys = data.digests ? Object.keys(data.digests) : [];
    const eligible = new Set(plan.eligible.map((e) => e.export));
    const done = doneKeys.filter((k) => eligible.has(k)).length;
    if (done > 0 && done < plan.digests) {
      const remaining = plan.digests - done;
      return `${done} of ${plan.digests} digests already done; will run ${remaining} + ${plan.cluster} + ~${plan.authorEstimate}`;
    }
  } catch {
    // no checkpoint yet, or unreadable — no resume note
  }
  return undefined;
}

/**
 * Consent-time (pre-spend) overflow estimate: which eligible sessions have an
 * export larger than the budget. Uses cheap `statSync` byte sizes (no content
 * read) — an estimate that the pipeline's exact char-length check refines. A
 * missing export is left for the digest stage to report as a read failure.
 */
function computeOversized(
  home: string,
  eligible: ManifestEntry[],
  budget: number,
): { export: string; chars: number }[] {
  const out: { export: string; chars: number }[] = [];
  for (const e of eligible) {
    try {
      const { size } = fs.statSync(path.join(home, "exports", e.export));
      if (size > budget) out.push({ export: e.export, chars: size });
    } catch {
      // missing/unreadable export — the digest stage reports it as a failure
    }
  }
  return out;
}

/** Injectable dependencies (testing). */
export interface DistillDeps {
  confirm?: (plan: DistillPlan, opts: ConsentOptions) => Promise<ConsentResult>;
  /** Stage runner passed to the pipeline (default: real runClaude). */
  runner?: RunnerFn;
  input?: Readable;
  output?: Writable;
  /** Clipboard sink for the preferences cascade (injectable for tests). */
  clipboard?: (text: string) => Promise<{ ok: boolean; tool: string; error?: string }>;
}

/**
 * The distill command core. Returns the intended process exit code
 * (0 success/dry-run, 1 nothing exported / bad manifest / stage failure,
 * 2 consent declined) so the caller can set `process.exitCode` and tests can
 * assert without exiting.
 */
export async function runDistill(args: DistillArgs, deps: DistillDeps = {}): Promise<number> {
  const confirm = deps.confirm ?? defaultConfirm;
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);

  const { home } = resolvePaths(args);
  const manifestPath = path.join(home, "exports", "manifest.json");
  const sourceMode = parseSourceMode(args.source);
  // Which origins the distill plan should consider — a --source claude/kiro run
  // narrows the (possibly merged) manifest to that backend; auto keeps both.
  const activeOrigins: Set<SourceName> | undefined =
    sourceMode === "auto" ? undefined : new Set<SourceName>([sourceMode]);

  // We can prompt when there's a stream to prompt on: an injected input (tests)
  // or a real interactive stdin. In a pipe/CI without --yes we deliberately do
  // NOT prompt — behavior stays exactly as before (no surprise export, no
  // library dump). --yes proceeds through every offer without reading stdin.
  const canPrompt = deps.input !== undefined || process.stdin.isTTY === true;

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    // No manifest yet. Offer to run export first (deterministic, local, no LLM)
    // so a first-time user can go from zero to a library in one command. Same
    // read surface as the default `scan`, so this is not a new trust boundary;
    // the LLM consent gate below is untouched.
    if (args["dry-run"]) {
      write("nothing exported yet — run `cc-hindsight export` first (free, local), then re-run.");
      write(hint("cc-hindsight export"));
      return 1;
    }
    // Name the store(s) the offered export will read, per --source.
    const reads =
      sourceMode === "kiro"
        ? "~/.kiro"
        : sourceMode === "claude"
          ? "~/.claude"
          : "~/.claude and ~/.kiro";
    const doExport =
      Boolean(args.yes) ||
      (canPrompt &&
        (await askYesNo(
          `No exports yet. Run export now? (reads ${reads}, writes ~/.cc-hindsight; no LLM, nothing sent anywhere)`,
          { input: deps.input, output: deps.output, defaultYes: true },
        )));
    if (!doExport) {
      write("nothing exported yet");
      write(hint("cc-hindsight export"));
      return 1;
    }
    write();
    write("export — reading your sessions…");
    runExport({
      home: args.home,
      "claude-dir": args["claude-dir"],
      "kiro-dir": args["kiro-dir"],
      source: args.source,
      project: args.project,
      output: deps.output,
    } satisfies ExportArgs);
    write();
    try {
      raw = fs.readFileSync(manifestPath, "utf8");
    } catch {
      write("export produced no manifest — nothing to distill.");
      return 1;
    }
  }

  let entries: ManifestEntry[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("manifest is not an array");
    entries = parsed as ManifestEntry[];
  } catch (e) {
    write(`error: could not read manifest at ${manifestPath} (${(e as Error).message})`);
    return 1;
  }

  const minSubstance = parseClampedInt(args["min-substance"], { fallback: 2, min: 1 });
  const noGroup = args.group === false;
  const budget = resolveInputBudget(args["input-budget"]);
  const truncate = resolveTruncatePolicy(args.truncate);
  const timeoutMs = resolveTimeoutMs(args.timeout);
  const plan = computePlan(entries, {
    project: args.project,
    minSubstance,
    noGroup,
    activeOrigins,
  });

  if (plan.digests === 0) {
    const scope = args.project ? ` in project "${args.project}"` : "";
    write(`nothing to distill: no sessions with ≥ ${minSubstance} human messages${scope}.`);
    return 0;
  }

  // Resolve which local CLI distills. Default `auto`: prefer the runner matching
  // the active source, else fall back by binary availability. A kiro-only
  // machine (no `claude` binary) works out of the box. An EXPLICIT --runner
  // whose binary is missing fails here — before consent — with its install
  // hint. An injected deps.runner (tests) bypasses resolution and leaves the
  // consent copy at its claude default.
  let resolvedRunner: AgentRunner | null = null;
  if (!deps.runner) {
    try {
      resolvedRunner = await resolveRunner(parseRunnerMode(args.runner), {
        preferSource: sourceMode === "auto" ? undefined : sourceMode,
        scratchBase: path.join(home, "runner-scratch"),
      });
    } catch (err) {
      write((err as Error).message);
      return 1;
    }
  }
  const runner: RunnerFn = deps.runner ?? (resolvedRunner as AgentRunner).run;
  const runnerName: DistillPlan["runnerName"] = resolvedRunner?.name;

  // Once-per-run runner teardown, called at every terminal point AFTER stage
  // calls began: all concurrent workers have joined by then, so the kiro
  // runner's session cleanup can never race an in-flight sibling (deletion
  // happens once per run, per the scope invariant). Best-effort by contract.
  const finishRun = async (code: number): Promise<number> => {
    await resolvedRunner?.finalize?.();
    return code;
  };

  // Consent-time (pre-spend) overflow estimate.
  const oversized = computeOversized(home, plan.eligible, budget);

  // Default (--truncate=never): refuse BEFORE spending anything if any session
  // exceeds the budget. Nothing is ever cut silently — the user chooses a flag.
  // (Dry-run still previews the plan below and notes the would-be block.)
  if (!args["dry-run"] && truncate === "never" && oversized.length > 0) {
    write();
    write(
      `${oversized.length} session(s) exceed the input budget (${budget} chars); nothing was invoked:`,
    );
    for (const o of oversized) {
      write(`  ${skip(`${cyan(o.export)} ${dim(`(${o.chars} chars)`)}`)}`);
    }
    write(
      dim(
        "re-run with --truncate=extreme to cut them middle-out, --input-budget <n> to raise the ceiling, or --project / --min-substance to narrow scope.",
      ),
    );
    return 1;
  }

  // --fresh intent is confirmed up front, but the checkpoints are NOT deleted
  // until the MAIN consent gate also passes: declining the invocation prompt
  // after confirming --fresh must not have already destroyed paid progress
  // while running nothing. Dry-run never clears anything.
  let freshConfirmed = false;
  if (args.fresh && !args["dry-run"]) {
    freshConfirmed =
      Boolean(args.yes) ||
      (await askYesNo(
        "--fresh clears distill checkpoints (digest/cluster progress) and re-runs everything. Continue?",
        { input: deps.input, output: deps.output },
      ));
    if (!freshConfirmed) {
      write("declined; checkpoints kept, nothing was invoked.");
      return 2;
    }
  }

  const distillPlan: DistillPlan = {
    digests: plan.digests,
    cluster: plan.cluster,
    authorEstimate: plan.authorEstimate,
    runnerName,
    resumeNote: computeResumeNote(home, plan, Boolean(args.fresh)),
    budget,
    truncate,
    oversized,
  };

  const decision = await confirm(distillPlan, {
    yes: Boolean(args.yes),
    dryRun: Boolean(args["dry-run"]),
    input: deps.input,
    output: deps.output,
  });

  if (decision === "dry-run") {
    write();
    write(`${banner("digest", `${plan.eligible.length} session(s)`)}:`);
    for (const e of plan.eligible) {
      write(`  ${dim("•")} ${cyan(e.export)} ${dim(`(${e.messages} msgs)`)}`);
    }
    write(
      `${banner("cluster", `${plan.cluster} call${noGroup ? " (skipped: --no-group)" : ""}`)}.`,
    );
    write(
      `${banner("author", `~${plan.authorEstimate} task(s)`)} ${dim("(exact count known after clustering)")}.`,
    );
    if (oversized.length > 0) {
      const verb =
        truncate === "extreme"
          ? "cut middle-out"
          : "BLOCKED (re-run with --truncate=extreme or --input-budget)";
      write();
      write(
        `${banner("budget", `${oversized.length} session(s) over ${budget} chars → ${verb}`)}:`,
      );
      for (const o of oversized) {
        write(`  ${skip(`${cyan(o.export)} ${dim(`(${o.chars} chars)`)}`)}`);
      }
    }
    return 0;
  }

  if (decision === "declined") {
    write("declined; nothing was invoked.");
    return 2;
  }

  // Both gates passed — only now is it safe to clear checkpoints.
  if (freshConfirmed) {
    clearCheckpoints(home);
    write("checkpoints cleared.");
  }

  // proceed — stage 1: digest
  write();
  write(`${banner("digest", `${plan.digests} session(s)`)}:`);
  const digestResult = await runDigestStage({
    home,
    entries: plan.eligible,
    model: args.model,
    runner,
    output: deps.output,
    budget,
    truncate,
    timeoutMs,
    concurrency: parseClampedInt(args.concurrency, { fallback: 3, min: 1 }),
    // citty maps `--no-breaker` to breaker: false; on by default.
    breaker: args.breaker !== false,
  });

  const doneTotal = digestResult.completed + digestResult.skipped;
  const digestSummary =
    `digest stage: ${doneTotal}/${plan.digests} done` +
    (digestResult.skipped ? ` (${digestResult.skipped} resumed from checkpoint)` : "") +
    (digestResult.failed.length ? `, ${digestResult.failed.length} failed` : "") +
    // Say the count is short BECAUSE the stage stopped early, so "0/92 done"
    // is never mistaken for "92 sessions were each tried and failed".
    (digestResult.aborted ? `, ${digestResult.notAttempted.length} not attempted (stopped)` : "");
  write(digestResult.failed.length ? digestSummary : green(digestSummary));

  if (digestResult.failed.length > 0) {
    write();
    write("failed sessions (progress is checkpointed; re-run to retry):");
    for (const f of digestResult.failed) {
      write(`  ${fail(`${f.export}: ${f.error}`)}`);
    }
    // Do NOT abort here. A reproducibly-failing session must not block the
    // whole pipeline forever — proceed to cluster/author with the digests that
    // DID succeed (the cluster input already tolerates absent digests), and
    // exit non-zero at the very end, after the useful work is done.
  }

  if (digestResult.blocked.length > 0) {
    write();
    write(
      `blocked ${digestResult.blocked.length} session(s) exceeding the input budget (${budget} chars):`,
    );
    for (const b of digestResult.blocked) {
      write(`  ${skip(`${b.export}: ${b.chars} chars`)}`);
    }
    write(dim("  re-run with --truncate=extreme to cut them, or raise --input-budget."));
  }

  // stage 2: cluster — input is the checkpointed digests for the CURRENT
  // eligible set (sessions whose digest failed are simply absent).
  const digestCheckpoint = loadDigests(home);
  const digestsForCluster: Record<string, Digest> = {};
  for (const e of plan.eligible) {
    const digest = digestCheckpoint?.digests[e.export];
    if (digest) digestsForCluster[e.export] = digest;
  }

  if (Object.keys(digestsForCluster).length === 0) {
    write();
    write("no sessions were successfully digested; nothing to cluster.");
    return finishRun(1);
  }

  // Track whether ANY failure occurred so the command exits non-zero after
  // completing the reachable work. Blocked-by-budget sessions count too.
  let hadFailure = digestResult.failed.length > 0 || digestResult.blocked.length > 0;

  write();
  write(`${banner("cluster", noGroup ? "--no-group" : "1 call")}:`);

  try {
    // Backend per export (absent ⇒ claude): names the corpus in the cluster
    // prompt (named single-source, neutral for merged corpora).
    const clusterOrigins: Record<string, SourceName> = {};
    for (const e of plan.eligible) clusterOrigins[e.export] = e.origin ?? "claude";
    const clusterResult = await runClusterStage({
      home,
      digests: digestsForCluster,
      origins: clusterOrigins,
      generation: digestResult.generation,
      noGroup,
      model: args.model,
      runner,
      output: deps.output,
      budget,
      timeoutMs,
    });
    for (const t of clusterResult.tasks) {
      write(`      ${t.slug} (${t.members.length} session${t.members.length === 1 ? "" : "s"})`);
    }

    // stage 3: author (one call per viable task; the library IS the checkpoint)
    write();
    write(`${banner("author", `${clusterResult.tasks.length} task(s)`)}:`);
    const authorResult = await runAuthorStage({
      home,
      tasks: clusterResult.tasks,
      digests: digestsForCluster,
      entries: plan.eligible,
      generation: digestResult.generation,
      toolVersion: pkg.version,
      model: args.model,
      runner,
      output: deps.output,
      budget,
      truncate,
      timeoutMs,
      force: args.force === true,
      concurrency: parseClampedInt(args.concurrency, { fallback: 3, min: 1 }),
    });

    write();
    const authoredTotal = authorResult.authored.length + authorResult.resumed.length;
    const librarySummary =
      `library: ${authoredTotal} entr${authoredTotal === 1 ? "y" : "ies"} authored` +
      (authorResult.resumed.length ? ` (${authorResult.resumed.length} resumed)` : "") +
      (authorResult.skipped.length
        ? `, ${authorResult.skipped.length} task(s) skipped (no successful sessions)`
        : "") +
      (clusterResult.misc.length ? `, ${clusterResult.misc.length} session(s) in misc` : "");
    write(authoredTotal > 0 ? green(librarySummary) : librarySummary);
    for (const s of authorResult.skipped) {
      write(`  · skipped ${s.slug}: ${s.reason}`);
    }

    if (authorResult.failed.length > 0) {
      write();
      write("failed tasks (authored entries are kept; re-run to retry):");
      for (const f of authorResult.failed) {
        write(`  ${fail(`${f.export}: ${f.error}`)}`);
      }
      hadFailure = true;
    }

    // Best-effort cost visibility (kiro prints a Credits footer per call).
    const costLine = resolvedRunner?.costSummary?.();
    if (costLine) {
      write(dim(costLine));
    }

    // Offer to show the freshly-built library — the payoff of the one-shot flow
    // is watching it appear. Pure local display (no cost), so the default is
    // yes; --yes shows it without prompting; a pipe/CI without --yes just skips.
    if (authoredTotal > 0) {
      const show =
        Boolean(args.yes) ||
        (canPrompt &&
          (await askYesNo("Show your library now?", {
            input: deps.input,
            output: deps.output,
            defaultYes: true,
          })));
      if (show) {
        const libraryEntries = readLibrary(home);
        if (libraryEntries.length > 0) {
          write();
          write(renderLibraryTable(libraryEntries));
          write();
          write(
            green(
              `${libraryEntries.length} librar${libraryEntries.length === 1 ? "y entry" : "y entries"}`,
            ),
          );
          write(hint("cc-hindsight show <slug>"));
          write(hint("cc-hindsight copy <slug>"));
          await offerPreferencesCascade({
            home,
            runner,
            runnerName,
            yes: Boolean(args.yes),
            canPrompt,
            sourceMode,
            model: args.model,
            deps,
            output: out,
          });
          return finishRun(hadFailure ? 1 : 0);
        }
      }
    }
  } catch (err) {
    write(`  ${fail((err as Error).message)}`);
    write("  digest progress is checkpointed; re-run to retry clustering.");
    return finishRun(1);
  }

  write(hint("cc-hindsight list"));
  // Exit non-zero if anything failed (digest or author), but only AFTER the
  // reachable work completed and checkpointed.
  return finishRun(hadFailure ? 1 : 0);
}

/**
 * The press-enter cascade at the end of a successful distill: offer to
 * consolidate the freshly-authored preferences (one runner call, cost named in
 * the prompt) and copy the result to the clipboard. Enter accepts each step.
 * Same offer policy as the library display: --yes accepts everything without
 * reading stdin; a pipe/CI without --yes skips silently. The runner is the one
 * distill already resolved, so no second binary lookup or consent surface; the
 * distill exit code is never affected by this cascade (best-effort tail).
 */
async function offerPreferencesCascade(opts: {
  home: string;
  runner: RunnerFn;
  runnerName: "claude" | "kiro" | undefined;
  yes: boolean;
  canPrompt: boolean;
  sourceMode: "claude" | "kiro" | "auto";
  model?: string;
  deps: DistillDeps;
  output: Writable;
}): Promise<void> {
  const { home, runner, runnerName, yes, canPrompt, sourceMode, model, deps, output } = opts;
  const write = (s = "") => output.write(`${s}\n`);

  const entries = readLibrary(home);
  const prefs = aggregatePreferences(entries);
  if (prefs.length === 0) return; // nothing observed; keep the ending unchanged

  const cli = runnerName === "kiro" ? "kiro-cli" : "claude";
  write();
  const proceed =
    yes ||
    (canPrompt &&
      (await askYesNo(`Consolidate your preferences now (1 ${cli} call)?`, {
        input: deps.input,
        output: deps.output,
        defaultYes: true,
      })));
  if (!proceed) return;

  const target = resolveTarget(undefined, sourceMode);
  const { merged, block } = await runConsolidation({
    prefs,
    taskCount: entries.length,
    target,
    runner,
    model,
    output,
  });
  if (merged === null || block === null) return; // failure already rendered the fallback

  await offerCopyBlock({
    block,
    count: merged.length,
    target,
    yes,
    deps: { input: deps.input, output: deps.output, clipboard: deps.clipboard },
    output,
  });
}

export default defineCommand({
  meta: {
    name: "distill",
    description: "Digest, cluster, and author oneshot prompts (consent-gated)",
  },
  args: {
    ...sharedArgs,
    project: { type: "string", description: "Only distill sessions from this project" },
    group: {
      type: "boolean",
      default: true,
      description: "Group sessions into tasks (use --no-group for 1 session = 1 task)",
    },
    breaker: {
      type: "boolean",
      default: true,
      description:
        "Stop the digest stage after 5 consecutive identical failures (use --no-breaker to attempt every session)",
    },
    "min-substance": {
      type: "string",
      default: "2",
      description: "Minimum human messages for a session to be eligible",
    },
    model: { type: "string", description: "Model passed through to the runner's --model" },
    runner: {
      type: "string",
      description: "Which local CLI distills: claude, kiro, or auto (default: auto)",
    },
    fresh: { type: "boolean", description: "Reset distill checkpoints and start over" },
    "dry-run": { type: "boolean", description: "Print the invocation plan and exit; run nothing" },
    yes: { type: "boolean", description: "Skip the consent prompt (for scripting)" },
    "input-budget": {
      type: "string",
      description: "Max characters of session content per runner call (default 400000)",
    },
    truncate: {
      type: "string",
      description:
        "Overflow policy when content exceeds the budget: never (default, block & report) or extreme (cut middle-out)",
    },
    timeout: {
      type: "string",
      description: "Per-runner-call timeout in seconds (default 300)",
    },
    concurrency: {
      type: "string",
      description: "Digest and author calls run in parallel (default 3; 1 = sequential)",
    },
    force: {
      type: "boolean",
      description: "Re-author over oneshots you edited by hand (default: keep your edits)",
    },
  },
  async run({ args }) {
    const code = await runDistill(args as unknown as DistillArgs);
    if (code !== 0) process.exitCode = code;
  },
});
