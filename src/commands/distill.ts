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
import {
  clearCheckpoints,
  loadDigests,
  type RunnerFn,
  runAuthorStage,
  runClusterStage,
  runDigestStage,
} from "../distill/pipeline.js";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** One entry of `exports/manifest.json` (§5.3). */
export interface ManifestEntry {
  export: string;
  source: string;
  project: string;
  sessionId: string;
  messages: number;
  first_ts: string;
  last_ts: string;
}

/** Normalized args the distill core reads. */
export interface DistillArgs {
  home?: string;
  "claude-dir"?: string;
  project?: string;
  /** citty maps `--no-group` to `group: false`; grouping is on by default. */
  group?: boolean;
  "min-substance"?: string;
  model?: string;
  fresh?: boolean;
  "dry-run"?: boolean;
  yes?: boolean;
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
  inputs: { project?: string; minSubstance: number; noGroup: boolean },
): ComputedPlan {
  let eligible = entries;
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
 * Resume note (§5.7): when a digests checkpoint already holds some (but not
 * all) sessions, state how much is left. Best-effort — a missing or malformed
 * checkpoint simply yields no note.
 */
function computeResumeNote(home: string, plan: ComputedPlan, fresh: boolean): string | undefined {
  if (fresh) return undefined;
  try {
    const raw = fs.readFileSync(path.join(home, "distill", "digests.json"), "utf8");
    const data = JSON.parse(raw) as { digests?: Record<string, unknown> };
    const done = data.digests ? Object.keys(data.digests).length : 0;
    if (done > 0 && done < plan.digests) {
      const remaining = plan.digests - done;
      return `${done} of ${plan.digests} digests already done; will run ${remaining} + ${plan.cluster} + ~${plan.authorEstimate}`;
    }
  } catch {
    // no checkpoint yet, or unreadable — no resume note
  }
  return undefined;
}

/** Injectable dependencies (testing). */
export interface DistillDeps {
  confirm?: (plan: DistillPlan, opts: ConsentOptions) => Promise<ConsentResult>;
  /** Stage runner passed to the pipeline (default: real runClaude). */
  runner?: RunnerFn;
  input?: Readable;
  output?: Writable;
}

/**
 * The distill command core. Returns the intended process exit code
 * (0 success/dry-run, 1 nothing exported / bad manifest, 2 consent declined)
 * so the caller can set `process.exitCode` and tests can assert without exiting.
 *
 * NOTE: the digest → cluster → author pipeline lands in Tasks 7–9. For now this
 * wires the consent gate and reports what *would* run.
 */
export async function runDistill(args: DistillArgs, deps: DistillDeps = {}): Promise<number> {
  const confirm = deps.confirm ?? defaultConfirm;
  const out = deps.output ?? process.stdout;
  const write = (s = "") => out.write(`${s}\n`);

  const { home } = resolvePaths(args);
  const manifestPath = path.join(home, "exports", "manifest.json");

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    write("nothing exported yet");
    write(hint("cc-hindsight export"));
    return 1;
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

  const minSubstance = Number.parseInt(args["min-substance"] ?? "2", 10) || 2;
  const noGroup = args.group === false;
  const plan = computePlan(entries, { project: args.project, minSubstance, noGroup });

  if (plan.digests === 0) {
    const scope = args.project ? ` in project "${args.project}"` : "";
    write(`nothing to distill: no sessions with ≥ ${minSubstance} human messages${scope}.`);
    return 0;
  }

  // --fresh clears checkpoints only after an explicit confirmation (§5.7).
  // Dry-run never clears anything.
  if (args.fresh && !args["dry-run"]) {
    const confirmed =
      Boolean(args.yes) ||
      (await askYesNo(
        "--fresh clears distill checkpoints (digest/cluster progress) and re-runs everything. Continue?",
        { input: deps.input, output: deps.output },
      ));
    if (!confirmed) {
      write("declined; checkpoints kept, nothing was invoked.");
      return 2;
    }
    clearCheckpoints(home);
    write("checkpoints cleared.");
  }

  const distillPlan: DistillPlan = {
    digests: plan.digests,
    cluster: plan.cluster,
    authorEstimate: plan.authorEstimate,
    resumeNote: computeResumeNote(home, plan, Boolean(args.fresh)),
  };

  const decision = await confirm(distillPlan, {
    yes: Boolean(args.yes),
    dryRun: Boolean(args["dry-run"]),
    input: deps.input,
    output: deps.output,
  });

  if (decision === "dry-run") {
    write();
    write(`digest — ${plan.eligible.length} session(s):`);
    for (const e of plan.eligible) {
      write(`  • ${e.export} (${e.messages} msgs)`);
    }
    write(`cluster — ${plan.cluster} call${noGroup ? " (skipped: --no-group)" : ""}.`);
    write(`author  — ~${plan.authorEstimate} task(s) (exact count known after clustering).`);
    return 0;
  }

  if (decision === "declined") {
    write("declined; nothing was invoked.");
    return 2;
  }

  // proceed — stage 1: digest (cluster and author land in Tasks 8–9)
  write();
  write(`digest — ${plan.digests} session(s):`);
  const digestResult = await runDigestStage({
    home,
    entries: plan.eligible,
    model: args.model,
    runner: deps.runner,
    output: deps.output,
  });

  const doneTotal = digestResult.completed + digestResult.skipped;
  write(
    `digest stage: ${doneTotal}/${plan.digests} done` +
      (digestResult.skipped ? ` (${digestResult.skipped} resumed from checkpoint)` : "") +
      (digestResult.failed.length ? `, ${digestResult.failed.length} failed` : ""),
  );

  if (digestResult.failed.length > 0) {
    write();
    write("failed sessions (progress is checkpointed; re-run to retry):");
    for (const f of digestResult.failed) {
      write(`  ✗ ${f.export}: ${f.error}`);
    }
    return 1;
  }

  // stage 2: cluster — input is the checkpointed digests for the CURRENT
  // eligible set (sessions whose digest failed are simply absent).
  write();
  write(`cluster — ${noGroup ? "--no-group" : "1 call"}:`);
  const digestCheckpoint = loadDigests(home);
  const digestsForCluster: Record<string, Digest> = {};
  for (const e of plan.eligible) {
    const digest = digestCheckpoint?.digests[e.export];
    if (digest) digestsForCluster[e.export] = digest;
  }

  try {
    const clusterResult = await runClusterStage({
      home,
      digests: digestsForCluster,
      generation: digestResult.generation,
      noGroup,
      model: args.model,
      runner: deps.runner,
      output: deps.output,
    });
    for (const t of clusterResult.tasks) {
      write(`      ${t.slug} (${t.members.length} session${t.members.length === 1 ? "" : "s"})`);
    }

    // stage 3: author — one call per viable task; the library IS the checkpoint.
    write();
    write(`author — ${clusterResult.tasks.length} task(s):`);
    const authorResult = await runAuthorStage({
      home,
      tasks: clusterResult.tasks,
      digests: digestsForCluster,
      entries: plan.eligible,
      generation: digestResult.generation,
      toolVersion: pkg.version,
      model: args.model,
      runner: deps.runner,
      output: deps.output,
    });

    write();
    const authoredTotal = authorResult.authored.length + authorResult.resumed.length;
    write(
      `library: ${authoredTotal} entr${authoredTotal === 1 ? "y" : "ies"} authored` +
        (authorResult.resumed.length ? ` (${authorResult.resumed.length} resumed)` : "") +
        (authorResult.skipped.length
          ? `, ${authorResult.skipped.length} task(s) skipped (no successful sessions)`
          : "") +
        (clusterResult.misc.length ? `, ${clusterResult.misc.length} session(s) in _misc` : ""),
    );
    for (const s of authorResult.skipped) {
      write(`  · skipped ${s.slug}: ${s.reason}`);
    }

    if (authorResult.failed.length > 0) {
      write();
      write("failed tasks (authored entries are kept; re-run to retry):");
      for (const f of authorResult.failed) {
        write(`  ✗ ${f.export}: ${f.error}`);
      }
      return 1;
    }
  } catch (err) {
    write(`  ✗ ${(err as Error).message}`);
    write("  digest progress is checkpointed; re-run to retry clustering.");
    return 1;
  }

  write(hint("cc-hindsight list"));
  return 0;
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
    "min-substance": {
      type: "string",
      default: "2",
      description: "Minimum human messages for a session to be eligible",
    },
    model: { type: "string", description: "Model passed through to `claude --model`" },
    fresh: { type: "boolean", description: "Reset distill checkpoints and start over" },
    "dry-run": { type: "boolean", description: "Print the invocation plan and exit; run nothing" },
    yes: { type: "boolean", description: "Skip the consent prompt (for scripting)" },
  },
  async run({ args }) {
    const code = await runDistill(args as unknown as DistillArgs);
    if (code !== 0) process.exitCode = code;
  },
});
