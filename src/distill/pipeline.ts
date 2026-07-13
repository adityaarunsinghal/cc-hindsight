import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { buildClusterPrompt, CLUSTER_PROMPT_VERSION } from "../claude/prompts/cluster.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import { type RunClaudeOptions, runClaude } from "../claude/runner.js";
import {
  type Cluster,
  ClusterSchema,
  type ClusterTask,
  type Digest,
  DigestSchema,
} from "../claude/schemas.js";
import type { ManifestEntry } from "../commands/distill.js";
import type { OutcomeEvidence } from "../core/outcome.js";

/**
 * distill/pipeline.ts — stage orchestration, checkpoints, generations (F9).
 *
 * Every LLM stage checkpoints to `<home>/distill/` after EACH unit of work, so
 * Ctrl-C never loses paid progress and re-running skips completed work.
 * Checkpoints carry a generation id minted when a fresh pipeline starts;
 * downstream stages and `sources.json` copy it so `status` can flag artifacts
 * orphaned by re-clustering (`distill --fresh` resets deliberately).
 */

/** Signature of the stage runner — {@link runClaude} or a test double. */
export type RunnerFn = <T>(opts: RunClaudeOptions<T>) => Promise<T>;

/** The `distill/digests.json` checkpoint (§5.3). */
export interface DigestsCheckpoint {
  generation: string;
  prompt_version: number;
  digests: Record<string, Digest>;
}

/** Mint a new generation id: compact UTC stamp + short random suffix. */
export function newGeneration(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function digestsPath(home: string): string {
  return path.join(home, "distill", "digests.json");
}

/** Load the digests checkpoint; absent or unreadable → null (never throws). */
export function loadDigests(home: string): DigestsCheckpoint | null {
  try {
    const raw = fs.readFileSync(digestsPath(home), "utf8");
    const parsed = JSON.parse(raw) as DigestsCheckpoint;
    if (typeof parsed.generation !== "string" || typeof parsed.digests !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the digests checkpoint atomically (tmp file + rename) so a Ctrl-C
 * mid-write can never corrupt previously saved progress.
 */
export function saveDigests(home: string, checkpoint: DigestsCheckpoint): void {
  const target = digestsPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

/** Delete distill checkpoints (used by `distill --fresh`). */
export function clearCheckpoints(home: string): void {
  for (const file of ["digests.json", "tasks.json"]) {
    fs.rmSync(path.join(home, "distill", file), { force: true });
  }
}

/** Read `exports/outcomes.json` ({export → evidence}, `_note` ignored). */
function readOutcomes(home: string): Record<string, OutcomeEvidence> {
  try {
    const raw = fs.readFileSync(path.join(home, "exports", "outcomes.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, OutcomeEvidence> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "_note" || typeof value !== "object" || value === null) continue;
      out[key] = value as OutcomeEvidence;
    }
    return out;
  } catch {
    return {};
  }
}

/** One session that could not be digested this run. */
export interface StageFailure {
  export: string;
  error: string;
}

/** Result of the digest stage. */
export interface DigestStageResult {
  generation: string;
  /** Sessions digested by THIS run. */
  completed: number;
  /** Sessions already present in the checkpoint (resume). */
  skipped: number;
  failed: StageFailure[];
}

/** Options for {@link runDigestStage}. */
export interface DigestStageOptions {
  home: string;
  /** Eligible manifest entries (post `--project` / `--min-substance`). */
  entries: ManifestEntry[];
  model?: string;
  /** Injectable stage runner (default: real {@link runClaude}). */
  runner?: RunnerFn;
  /** Progress stream (default: process.stdout). */
  output?: Writable;
  /** Generation for a brand-new checkpoint (default: minted). */
  generation?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Stage 1 — digest every eligible session (one `claude` call each).
 *
 * Resumable: sessions already in the checkpoint are skipped; the checkpoint is
 * saved after EVERY successful digest; one session's failure never aborts the
 * rest (§5.9 — progress is kept, failures are reported, re-running resumes).
 */
export async function runDigestStage(opts: DigestStageOptions): Promise<DigestStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const checkpoint: DigestsCheckpoint = loadDigests(opts.home) ?? {
    generation: opts.generation ?? newGeneration(),
    prompt_version: DIGEST_PROMPT_VERSION,
    digests: {},
  };

  const outcomes = readOutcomes(opts.home);
  const failed: StageFailure[] = [];
  let completed = 0;
  let skipped = 0;
  const total = opts.entries.length;

  for (const [i, entry] of opts.entries.entries()) {
    const label = `[${i + 1}/${total}] ${entry.export}`;
    if (checkpoint.digests[entry.export]) {
      skipped++;
      write(`  ${label} — already digested (skipped)`);
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(path.join(opts.home, "exports", entry.export), "utf8");
    } catch (err) {
      failed.push({
        export: entry.export,
        error: `could not read export: ${(err as Error).message}`,
      });
      write(`  ${label} — ✗ unreadable export`);
      continue;
    }

    write(`  ${label} — digesting…`);
    try {
      const digest = await runner({
        prompt: buildDigestPrompt({
          exportName: entry.export,
          content,
          outcome: outcomes[entry.export],
        }),
        schema: DigestSchema,
        model: opts.model,
      });
      checkpoint.digests[entry.export] = digest;
      saveDigests(opts.home, checkpoint); // after each — Ctrl-C safe
      completed++;
      write(`      → ${digest.outcome}: ${truncate(digest.goal, 70)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ export: entry.export, error: message });
      write(`      ✗ failed: ${truncate(message, 120)}`);
      // continue — one failure doesn't abort the rest
    }
  }

  return { generation: checkpoint.generation, completed, skipped, failed };
}

// --- stage 2: cluster --------------------------------------------------------

/** The `distill/tasks.json` checkpoint (§5.3). */
export interface TasksCheckpoint {
  generation: string;
  prompt_version: number;
  tasks: ClusterTask[];
  misc: string[];
}

function tasksPath(home: string): string {
  return path.join(home, "distill", "tasks.json");
}

/** Load the tasks checkpoint; absent or unreadable → null (never throws). */
export function loadTasks(home: string): TasksCheckpoint | null {
  try {
    const raw = fs.readFileSync(tasksPath(home), "utf8");
    const parsed = JSON.parse(raw) as TasksCheckpoint;
    if (typeof parsed.generation !== "string" || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the tasks checkpoint atomically (tmp + rename). */
export function saveTasks(home: string, checkpoint: TasksCheckpoint): void {
  const target = tasksPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

/** Unique kebab slug of 2–5 words (1–4 dashes). */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/;

/**
 * Canonicalize member ids in a cluster response against the known input ids.
 *
 * Real-model failure mode (observed with sonnet on the first real run): every
 * id returned without its `.md` extension — semantically perfect grouping,
 * rejected by exact-string validation, one wasted retry. Repair is strictly
 * lossless: an unknown id is replaced only when exactly one known id matches
 * it after stripping the extension; anything else is left for validation to
 * report. Returns a new Cluster; the original is not mutated.
 */
export function canonicalizeClusterIds(cluster: Cluster, inputIds: string[]): Cluster {
  const known = new Set(inputIds);
  const byStem = new Map<string, string[]>();
  for (const id of inputIds) {
    const stem = id.replace(/\.md$/, "");
    byStem.set(stem, [...(byStem.get(stem) ?? []), id]);
  }
  const repair = (member: string): string => {
    if (known.has(member)) return member;
    const candidates = byStem.get(member.replace(/\.md$/, ""));
    return candidates?.length === 1 && candidates[0] ? candidates[0] : member;
  };
  return {
    tasks: cluster.tasks.map((t) => ({ ...t, members: t.members.map(repair) })),
    misc: cluster.misc.map(repair),
  };
}

/**
 * Validate a clustering against the input ids (§5.6 — fail loudly):
 * slug format + uniqueness, full coverage (every id lands in a task or misc),
 * and no invented ids. Returns a list of problems; empty means valid.
 */
export function validateCluster(cluster: Cluster, inputIds: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(inputIds);
  const seenSlugs = new Set<string>();

  for (const task of cluster.tasks) {
    if (!SLUG_PATTERN.test(task.slug)) {
      problems.push(`slug "${task.slug}" is not 2-5 kebab-case words`);
    }
    if (seenSlugs.has(task.slug)) {
      problems.push(`duplicate slug "${task.slug}"`);
    }
    seenSlugs.add(task.slug);
    if (task.members.length === 0) {
      problems.push(`task "${task.slug}" has no members`);
    }
    for (const member of task.members) {
      if (!known.has(member)) {
        problems.push(`task "${task.slug}" references unknown session "${member}"`);
      }
    }
  }
  for (const member of cluster.misc) {
    if (!known.has(member)) {
      problems.push(`misc references unknown session "${member}"`);
    }
  }

  const covered = new Set<string>(cluster.misc);
  for (const task of cluster.tasks) {
    for (const member of task.members) covered.add(member);
  }
  for (const id of inputIds) {
    if (!covered.has(id)) {
      problems.push(`session "${id}" was dropped (not in any task or misc)`);
    }
  }

  return problems;
}

/** Deterministic slug from an export file name (for `--no-group`). */
function slugFromExportName(exportName: string, used: Set<string>): string {
  const stem = exportName.replace(/\.md$/, "");
  let segments = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5);
  if (segments.length === 0) segments = ["session"];
  if (segments.length === 1) segments.push("session"); // pattern needs ≥2 words
  let slug = segments.join("-");
  // Collisions: bump a numeric final segment (stays within the 5-word cap).
  for (let n = 2; used.has(slug); n++) {
    slug = [...segments.slice(0, 4), String(n)].join("-");
  }
  used.add(slug);
  return slug;
}

/**
 * `--no-group`: synthesize a 1 session = 1 task clustering deterministically —
 * no LLM call, no misc routing (the substance pre-filter already ran).
 */
export function synthesizeNoGroupTasks(digests: Record<string, Digest>): Cluster {
  const used = new Set<string>();
  const tasks: ClusterTask[] = Object.keys(digests)
    .sort()
    .map((exportName) => ({
      slug: slugFromExportName(exportName, used),
      title: digests[exportName]?.goal || exportName,
      rationale: "1 session = 1 task (--no-group)",
      members: [exportName],
    }));
  return { tasks, misc: [] };
}

/** Result of the cluster stage. */
export interface ClusterStageResult {
  generation: string;
  tasks: ClusterTask[];
  misc: string[];
  /** True when the checkpoint already covered this input (no call made). */
  resumed: boolean;
}

/** Options for {@link runClusterStage}. */
export interface ClusterStageOptions {
  home: string;
  /** Digests for the CURRENT eligible sessions (input to the clusterer). */
  digests: Record<string, Digest>;
  generation: string;
  noGroup?: boolean;
  model?: string;
  runner?: RunnerFn;
  output?: Writable;
}

/**
 * Stage 2 — cluster all digests into semantic tasks (one call total).
 *
 * Resumable: a tasks.json from the same generation covering the same input set
 * is reused without a call. Semantic validation failures (duplicate slugs,
 * dropped sessions, invented ids) get ONE corrective retry with the problems
 * spelled out; a second failure throws (§5.9 — progress stays checkpointed,
 * the command reports and exits non-zero, re-running resumes).
 */
export async function runClusterStage(opts: ClusterStageOptions): Promise<ClusterStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);
  const inputIds = Object.keys(opts.digests).sort();

  // Resume: same generation + same covered input set → reuse, no call.
  const existing = loadTasks(opts.home);
  if (existing && existing.generation === opts.generation) {
    const covered = new Set<string>(existing.misc);
    for (const task of existing.tasks) for (const m of task.members) covered.add(m);
    const same = covered.size === inputIds.length && inputIds.every((id) => covered.has(id));
    if (same) {
      write("  clustering already done (checkpoint reused)");
      return {
        generation: existing.generation,
        tasks: existing.tasks,
        misc: existing.misc,
        resumed: true,
      };
    }
  }

  let cluster: Cluster;
  if (opts.noGroup) {
    cluster = synthesizeNoGroupTasks(opts.digests);
    write(
      `  --no-group: synthesized ${cluster.tasks.length} task(s) deterministically (no claude call)`,
    );
  } else {
    write(`  clustering ${inputIds.length} digest(s)…`);
    const basePrompt = buildClusterPrompt(opts.digests);
    cluster = canonicalizeClusterIds(
      await runner({ prompt: basePrompt, schema: ClusterSchema, model: opts.model }),
      inputIds,
    );

    let problems = validateCluster(cluster, inputIds);
    if (problems.length > 0) {
      write(`      response failed validation (${problems.length} problem(s)); retrying once…`);
      const corrective =
        `${basePrompt}\n\nYour previous grouping had these problems:\n` +
        `${problems.map((p) => `- ${p}`).join("\n")}\n` +
        "Produce a corrected grouping that fixes every problem. Remember: every id in at " +
        "least one task or misc, unique 2-5-word kebab-case slugs, only the listed ids.";
      cluster = canonicalizeClusterIds(
        await runner({ prompt: corrective, schema: ClusterSchema, model: opts.model }),
        inputIds,
      );
      problems = validateCluster(cluster, inputIds);
      if (problems.length > 0) {
        throw new Error(`clustering failed validation after one retry: ${problems.join("; ")}`);
      }
    }
  }

  const checkpoint: TasksCheckpoint = {
    generation: opts.generation,
    prompt_version: CLUSTER_PROMPT_VERSION,
    tasks: cluster.tasks,
    misc: cluster.misc,
  };
  saveTasks(opts.home, checkpoint);

  write(
    `      → ${cluster.tasks.length} task(s), ${cluster.misc.length} session(s) routed to _misc`,
  );
  return { generation: opts.generation, tasks: cluster.tasks, misc: cluster.misc, resumed: false };
}
