import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import {
  AUTHOR_PROMPT_VERSION,
  type AuthorMemberInput,
  buildAuthorPrompt,
} from "../claude/prompts/author.js";
import { buildClusterPrompt, CLUSTER_PROMPT_VERSION } from "../claude/prompts/cluster.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import { type RunClaudeOptions, runClaude } from "../claude/runner.js";
import {
  AuthorSchema,
  type Cluster,
  ClusterSchema,
  type ClusterTask,
  type Digest,
  DigestSchema,
} from "../claude/schemas.js";
import type { ManifestEntry } from "../commands/distill.js";
import type { AnaphoraRecord } from "../core/anaphora.js";
import { parseAnaphoraMap, parseSourcesJson } from "../core/artifacts.js";
import { DEFAULT_INPUT_BUDGET, middleCut, type TruncatePolicy } from "../core/budget.js";
import { mkdirPrivate, writeFilePrivate } from "../core/fsutil.js";
import { oneshotHash } from "../core/library.js";
import type { OutcomeEvidence } from "../core/outcome.js";
import { withSpinner } from "../ui/progress.js";
import { fail, green, skip as skipGlyph } from "../ui/style.js";

/**
 * distill/pipeline.ts — stage orchestration, checkpoints, generations.
 *
 * Every LLM stage checkpoints to `<home>/distill/` after EACH unit of work, so
 * Ctrl-C never loses paid progress and re-running skips completed work.
 * Checkpoints carry a generation id minted when a fresh pipeline starts;
 * downstream stages and `sources.json` copy it so `status` can flag artifacts
 * orphaned by re-clustering (`distill --fresh` resets deliberately).
 */

/** Signature of the stage runner — {@link runClaude} or a test double. */
export type RunnerFn = <T>(opts: RunClaudeOptions<T>) => Promise<T>;

/** The `distill/digests.json` checkpoint. */
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
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.generation !== "string") return null;
    // Validate each digest independently and keep the valid ones: a single
    // corrupt entry must not discard the whole (paid) checkpoint. A dropped
    // key simply gets re-digested on the next run.
    const digests: Record<string, Digest> = {};
    if (obj.digests && typeof obj.digests === "object") {
      for (const [key, value] of Object.entries(obj.digests as Record<string, unknown>)) {
        const d = DigestSchema.safeParse(value);
        if (d.success) digests[key] = d.data;
      }
    }
    const prompt_version =
      typeof obj.prompt_version === "number" ? obj.prompt_version : DIGEST_PROMPT_VERSION;
    return { generation: obj.generation, prompt_version, digests };
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
  mkdirPrivate(path.dirname(target));
  const tmp = `${target}.tmp`;
  writeFilePrivate(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`);
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

/** A session blocked because its content exceeds the input budget (--truncate=never). */
export interface BlockedSession {
  export: string;
  chars: number;
}

/** Result of the digest stage. */
export interface DigestStageResult {
  generation: string;
  /** Sessions digested by THIS run. */
  completed: number;
  /** Sessions already present in the checkpoint (resume). */
  skipped: number;
  failed: StageFailure[];
  /** Sessions blocked for exceeding the input budget under --truncate=never. */
  blocked: BlockedSession[];
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
  /** Max chars of content per digest call (default {@link DEFAULT_INPUT_BUDGET}). */
  budget?: number;
  /** Overflow policy when content exceeds the budget (default "never"). */
  truncate?: TruncatePolicy;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
  /** Max digest calls in flight at once (default 1 — sequential). */
  concurrency?: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Stage 1 — digest every eligible session (one `claude` call each).
 *
 * Resumable: sessions already in the checkpoint are skipped; the checkpoint is
 * saved after EVERY successful digest; one session's failure never aborts the
 * rest — progress is kept, failures are reported, re-running resumes.
 */
export async function runDigestStage(opts: DigestStageOptions): Promise<DigestStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const loaded = loadDigests(opts.home);
  const checkpoint: DigestsCheckpoint = loaded ?? {
    generation: opts.generation ?? newGeneration(),
    prompt_version: DIGEST_PROMPT_VERSION,
    digests: {},
  };
  // Provenance that's recorded but never checked gives stale-by-construction
  // artifacts. If the checkpoint was written by a different digest prompt,
  // reused digests are stale — surface it (re-running with --fresh regenerates).
  if (loaded && loaded.prompt_version !== DIGEST_PROMPT_VERSION) {
    write(
      `  ⚠ existing digests were produced by prompt v${loaded.prompt_version}; current is v${DIGEST_PROMPT_VERSION}. Reusing them — run --fresh to regenerate.`,
    );
  }

  const outcomes = readOutcomes(opts.home);
  const failed: StageFailure[] = [];
  const blocked: BlockedSession[] = [];
  const budget = opts.budget ?? DEFAULT_INPUT_BUDGET;
  const truncatePolicy: TruncatePolicy = opts.truncate ?? "never";
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let completed = 0;
  let skipped = 0;
  const total = opts.entries.length;

  /** Digest one session end-to-end (skip / read / budget / call / checkpoint). */
  const digestOne = async (entry: ManifestEntry, i: number): Promise<void> => {
    const label = `[${i + 1}/${total}] ${entry.export}`;
    if (checkpoint.digests[entry.export]) {
      skipped++;
      write(`  ${label} — already digested (skipped)`);
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(path.join(opts.home, "exports", entry.export), "utf8");
    } catch (err) {
      failed.push({
        export: entry.export,
        error: `could not read export: ${(err as Error).message}`,
      });
      write(`  ${label} — ${fail("unreadable export")}`);
      return;
    }

    // Input budget / overflow policy. Nothing is cut silently.
    if (content.length > budget) {
      if (truncatePolicy === "never") {
        blocked.push({ export: entry.export, chars: content.length });
        write(
          `  ${label} — ${skipGlyph(`blocked: ${content.length} chars exceed the input budget (${budget}).`)} ` +
            "Re-run with --truncate=extreme or a larger --input-budget.",
        );
        return; // pre-spend block — no claude call
      }
      const cut = middleCut(content, budget);
      content = cut.text;
      write(`  ${label} — ✂ cut ${cut.dropped} chars to fit the input budget (--truncate=extreme)`);
    }

    write(`  ${label} — digesting…`);
    try {
      const call = () =>
        runner({
          prompt: buildDigestPrompt({
            exportName: entry.export,
            content,
            outcome: outcomes[entry.export],
            origin: entry.origin,
          }),
          schema: DigestSchema,
          model: opts.model,
          timeoutMs: opts.timeoutMs,
        });
      // A spinner is a single-line UI; with parallel calls in flight the lines
      // would fight over the cursor — plain progress lines instead.
      const digest =
        concurrency === 1 ? await withSpinner(out, `${label} — digesting`, call) : await call();
      // Mutation + save are synchronous (single JS tick), so concurrent
      // workers can never interleave a checkpoint write — saves stay serialized.
      checkpoint.digests[entry.export] = digest;
      saveDigests(opts.home, checkpoint); // after each — Ctrl-C safe
      completed++;
      write(`  ${label} → ${green(digest.outcome)}: ${truncate(digest.goal, 70)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ export: entry.export, error: message });
      write(`  ${label} ${fail(`failed: ${truncate(message, 120)}`)}`);
      // continue — one failure doesn't abort the rest
    }
  };

  // Bounded worker pool: N workers pull the next un-started entry until none
  // remain. concurrency=1 degrades to the exact sequential behavior.
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < opts.entries.length) {
      const i = nextIndex++;
      const entry = opts.entries[i];
      if (entry) await digestOne(entry, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()),
  );

  return { generation: checkpoint.generation, completed, skipped, failed, blocked };
}

// --- stage 2: cluster --------------------------------------------------------

/** The `distill/tasks.json` checkpoint. */
export interface TasksCheckpoint {
  generation: string;
  prompt_version: number;
  tasks: ClusterTask[];
  misc: string[];
}

function tasksPath(home: string): string {
  return path.join(home, "distill", "tasks.json");
}

/** Zod shape for the tasks checkpoint; task shape reused from ClusterSchema. */
const TasksCheckpointSchema = z.looseObject({
  generation: z.string(),
  prompt_version: z.number().catch(0),
  tasks: ClusterSchema.shape.tasks,
  misc: z.array(z.string()).catch([]),
});

/** Load the tasks checkpoint; absent, unreadable, or malformed → null (never throws). */
export function loadTasks(home: string): TasksCheckpoint | null {
  try {
    const raw = fs.readFileSync(tasksPath(home), "utf8");
    const parsed = TasksCheckpointSchema.safeParse(JSON.parse(raw));
    // A malformed grouping must not corrupt coverage math — reject wholesale so
    // the cluster stage re-runs (one call) rather than trusting bad tasks.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the tasks checkpoint atomically (tmp + rename). */
export function saveTasks(home: string, checkpoint: TasksCheckpoint): void {
  const target = tasksPath(home);
  mkdirPrivate(path.dirname(target));
  const tmp = `${target}.tmp`;
  writeFilePrivate(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`);
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
 * Validate a clustering against the input ids — fail loudly:
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
  /** Backend per export name (absent entries ⇒ claude) — names the corpus in the prompt. */
  origins?: Record<string, "claude" | "kiro">;
  generation: string;
  noGroup?: boolean;
  model?: string;
  runner?: RunnerFn;
  output?: Writable;
  /** Input budget (chars) — used only to warn when the digest set is very large. */
  budget?: number;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
}

/**
 * Stage 2 — cluster all digests into semantic tasks (one call total).
 *
 * Resumable: a tasks.json from the same generation covering the same input set
 * is reused without a call. Semantic validation failures (duplicate slugs,
 * dropped sessions, invented ids) get ONE corrective retry with the problems
 * spelled out; a second failure throws — progress stays checkpointed,
 * the command reports and exits non-zero, re-running resumes.
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
      if (existing.prompt_version !== CLUSTER_PROMPT_VERSION) {
        write(
          `  ⚠ existing clustering was produced by prompt v${existing.prompt_version}; current is v${CLUSTER_PROMPT_VERSION}. Reusing it — run --fresh to regenerate.`,
        );
      }
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
    const basePrompt = buildClusterPrompt(opts.digests, opts.origins);
    // Cluster is a single call over ALL digests; warn (don't block) if the set
    // is large enough to risk a context rejection (the eventual answer is
    // windowed clustering — a roadmap item).
    if (opts.budget !== undefined && basePrompt.length > opts.budget) {
      write(
        `  ⚠ clustering ${inputIds.length} digests is ${basePrompt.length} chars (> budget ${opts.budget}); ` +
          "this may hit a model/context limit. Consider --project to narrow scope.",
      );
    }
    cluster = canonicalizeClusterIds(
      await withSpinner(out, `clustering ${inputIds.length} digest(s)`, () =>
        runner({
          prompt: basePrompt,
          schema: ClusterSchema,
          model: opts.model,
          timeoutMs: opts.timeoutMs,
        }),
      ),
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
        await withSpinner(out, "retrying with corrections", () =>
          runner({
            prompt: corrective,
            schema: ClusterSchema,
            model: opts.model,
            timeoutMs: opts.timeoutMs,
          }),
        ),
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
    `      → ${cluster.tasks.length} task(s), ${cluster.misc.length} session(s) routed to misc`,
  );
  return { generation: opts.generation, tasks: cluster.tasks, misc: cluster.misc, resumed: false };
}

// --- stage 3: author ---------------------------------------------------------

/**
 * `library/<slug>/sources.json` — full provenance for one entry.
 *
 * The type is derived from the read-validation schema in core/artifacts.ts and
 * re-exported here for existing importers, so the write shape (what the author
 * stage produces below) and the read validation (what browsing commands trust)
 * are one source of truth and cannot drift.
 */
export type { SourcesJson } from "../core/artifacts.js";

import type { SourcesJson } from "../core/artifacts.js";

/** A task skipped by the author stage, with the reason (reported by status). */
export interface SkippedTask {
  slug: string;
  reason: string;
}

/** Result of the author stage. */
export interface AuthorStageResult {
  generation: string;
  /** Tasks authored by THIS run. */
  authored: string[];
  /** Tasks already authored in this generation (resume). */
  resumed: string[];
  /** Tasks skipped (no completed/partial member session). */
  skipped: SkippedTask[];
  failed: StageFailure[];
}

/** Options for {@link runAuthorStage}. */
export interface AuthorStageOptions {
  home: string;
  tasks: ClusterTask[];
  /** Digests for outcome classification and prompt context. */
  digests: Record<string, Digest>;
  /** Manifest entries to map export names → session ids. */
  entries: ManifestEntry[];
  generation: string;
  toolVersion: string;
  model?: string;
  runner?: RunnerFn;
  output?: Writable;
  /** Max chars of aggregate member content per author call (default {@link DEFAULT_INPUT_BUDGET}). */
  budget?: number;
  /** Overflow policy when a task's members exceed the budget (default "never"). */
  truncate?: TruncatePolicy;
  /** Per-call timeout (ms) passed through to the runner. */
  timeoutMs?: number;
  /** Overwrite oneshots the user edited by hand (default: keep them). */
  force?: boolean;
  /** Max author calls in flight at once (default 1 — sequential). */
  concurrency?: number;
}

/** Read `exports/anaphora.json` ({export → records}); absent/invalid → {}. */
function readAnaphora(home: string): Record<string, AnaphoraRecord[]> {
  try {
    const raw = fs.readFileSync(path.join(home, "exports", "anaphora.json"), "utf8");
    // Validate + drop malformed per-export record arrays.
    return parseAnaphoraMap(JSON.parse(raw)) as Record<string, AnaphoraRecord[]>;
  } catch {
    return {};
  }
}

/** Order-insensitive membership equality for the author resume check. */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, i) => value === sortedB[i]);
}

/** Summarize member outcomes, e.g. "2 completed, 1 partial". */
export function summarizeOutcomes(members: string[], digests: Record<string, Digest>): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const outcome = digests[m]?.outcome ?? "unclear";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return ["completed", "partial", "abandoned", "unclear"]
    .filter((o) => counts.has(o))
    .map((o) => `${counts.get(o)} ${o}`)
    .join(", ");
}

/** The provenance header comment written at the top of every oneshot file. */
function provenanceComment(sources: SourcesJson): string {
  return [
    "<!--",
    `  generated by cc-hindsight v${sources.tool_version}`,
    `  task: ${sources.slug} (generation ${sources.generation})`,
    `  sources: ${sources.members.join(", ")}`,
    `  outcomes: ${sources.outcome_summary}; confidence: ${sources.confidence}`,
    `  model: ${sources.model ?? "runner default"}; prompt v${sources.prompt_version}; ${sources.authored_at}`,
    "-->",
  ].join("\n");
}

/**
 * Stage 3 — author one oneshot per task (one call each): the heart of the tool.
 *
 * Skip rule: tasks with NO completed/partial member session are skipped
 * and reported — never distilled into confident prompts that reproduce failure
 * paths. Resume: a task whose `sources.json` already carries this generation is
 * done (the library files ARE the checkpoint). One task's failure never aborts
 * the rest.
 */
export async function runAuthorStage(opts: AuthorStageOptions): Promise<AuthorStageResult> {
  const runner: RunnerFn = opts.runner ?? runClaude;
  const out = opts.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const anaphora = readAnaphora(opts.home);
  const sessionIdByExport = new Map(opts.entries.map((e) => [e.export, e.sessionId]));
  const originByExport = new Map(opts.entries.map((e) => [e.export, e.origin ?? "claude"]));

  const result: AuthorStageResult = {
    generation: opts.generation,
    authored: [],
    resumed: [],
    skipped: [],
    failed: [],
  };
  const total = opts.tasks.length;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  /** Author one task end-to-end (skip / resume / budget / call / write). */
  const authorOne = async (task: ClusterTask, i: number): Promise<void> => {
    const label = `[${i + 1}/${total}] ${task.slug}`;
    const dir = path.join(opts.home, "library", task.slug);
    const sourcesPath = path.join(dir, "sources.json");

    // Skip: no member with a completed or partial outcome.
    const viable = task.members.some((m) => {
      const outcome = opts.digests[m]?.outcome;
      return outcome === "completed" || outcome === "partial";
    });
    if (!viable) {
      result.skipped.push({
        slug: task.slug,
        reason:
          "no completed/partial member session (outcomes: " +
          `${summarizeOutcomes(task.members, opts.digests) || "none"})`,
      });
      write(`  ${label} — skipped (no completed/partial member session)`);
      return;
    }

    // Resume: an existing sources.json counts as "done" only when it was
    // authored in THIS generation AND its recorded members still match the task
    // exactly. Incremental re-clustering re-runs under the same generation id
    // (the digests checkpoint mints it once), so a generation-only check would
    // "resume" a task whose membership changed — presenting stale content as
    // current. Comparing members re-authors only the genuinely-changed tasks.
    let existing: SourcesJson | null = null;
    try {
      existing = parseSourcesJson(JSON.parse(fs.readFileSync(sourcesPath, "utf8")));
    } catch {
      // no prior entry (or unreadable) — author it
    }
    if (
      existing &&
      existing.generation === opts.generation &&
      sameMembers(existing.members, task.members)
    ) {
      result.resumed.push(task.slug);
      write(`  ${label} — already authored (skipped)`);
      return;
    }

    // Overwrite protection: if the user edited the oneshot since it
    // was authored (recorded hash ≠ current file hash), re-authoring would
    // silently destroy their work. Skip unless --force — checked pre-spend.
    if (existing?.oneshot_hash && !opts.force) {
      let currentHash: string | null = null;
      try {
        currentHash = oneshotHash(
          fs.readFileSync(path.join(dir, `${task.slug}.oneshot.md`), "utf8"),
        );
      } catch {
        // oneshot file gone — nothing to protect
      }
      if (currentHash !== null && currentHash !== existing.oneshot_hash) {
        result.skipped.push({
          slug: task.slug,
          reason: "oneshot was edited by hand — re-run with --force to overwrite",
        });
        write(`  ${label} — ✋ edited by hand; kept (re-run with --force to overwrite)`);
        return;
      }
    }

    const members: AuthorMemberInput[] = [];
    let unreadableMember: string | null = null;
    for (const m of task.members) {
      try {
        const content = fs.readFileSync(path.join(opts.home, "exports", m), "utf8");
        members.push({
          exportName: m,
          content,
          digest: opts.digests[m],
          anaphora: anaphora[m],
          origin: originByExport.get(m),
        });
      } catch {
        unreadableMember = m;
        break;
      }
    }
    // Authoring a "realistic ideal prompt" from a placeholder silently
    // degrades quality — the digest stage already treats an unreadable export as
    // a failure, so the author stage must too. Fail the task; re-running retries.
    if (unreadableMember) {
      result.failed.push({
        export: task.slug,
        error: `member export unreadable: ${unreadableMember}`,
      });
      write(`  ${label} — ${fail(`member export unreadable: ${unreadableMember}`)}`);
      return;
    }

    // Input budget / overflow policy for the aggregate of all member content.
    // Bounds by BLOCKING (never) or middle-cutting each member (extreme) —
    // never silently. Lossless chunking (draft→refine) is a roadmap item.
    const budget = opts.budget ?? DEFAULT_INPUT_BUDGET;
    const truncatePolicy: TruncatePolicy = opts.truncate ?? "never";
    const totalChars = members.reduce((n, m) => n + m.content.length, 0);
    let inputCoverage = 1;
    const truncations: { export: string; block: number; dropped_chars: number }[] = [];
    if (totalChars > budget) {
      if (truncatePolicy === "never") {
        result.failed.push({
          export: task.slug,
          error:
            `task input (${totalChars} chars across ${members.length} member(s)) exceeds the input ` +
            `budget (${budget}). Re-run with --truncate=extreme or a larger --input-budget.`,
        });
        write(
          `  ${label} — ${skipGlyph(`blocked: ${totalChars} chars exceed the input budget (${budget}).`)} ` +
            "Re-run with --truncate=extreme or a larger --input-budget.",
        );
        return; // pre-spend block
      }
      // extreme: give each member an equal slice of the budget, cut middle-out,
      // and record exactly what was dropped for provenance.
      const perMember = Math.max(1, Math.floor(budget / members.length));
      let totalDropped = 0;
      for (const m of members) {
        const cut = middleCut(m.content, perMember);
        if (cut.dropped > 0) {
          truncations.push({ export: m.exportName, block: 0, dropped_chars: cut.dropped });
        }
        m.content = cut.text;
        totalDropped += cut.dropped;
      }
      inputCoverage = totalChars > 0 ? (totalChars - totalDropped) / totalChars : 1;
      write(
        `  ${label} — ✂ cut ${totalDropped} chars to fit the input budget (--truncate=extreme)`,
      );
    }

    write(`  ${label} — authoring…`);
    try {
      const call = () =>
        runner({
          prompt: buildAuthorPrompt({ task, members }),
          schema: AuthorSchema,
          model: opts.model,
          timeoutMs: opts.timeoutMs,
        });
      // A spinner is a single-line UI; with parallel calls in flight the lines
      // would fight over the cursor — plain progress lines instead (mirrors the
      // digest stage).
      const authored =
        concurrency === 1 ? await withSpinner(out, `${label} — authoring`, call) : await call();

      // Our code writes the files; the TASK slug is authoritative for paths.
      const sources: SourcesJson = {
        slug: task.slug,
        title: authored.title,
        members: task.members,
        sessionIds: task.members.map((m) => sessionIdByExport.get(m) ?? "unknown"),
        preferences: authored.preferences,
        outcome_summary: summarizeOutcomes(task.members, opts.digests),
        domains: [
          ...new Set(
            task.members
              .map((m) => opts.digests[m]?.domain.trim().toLowerCase())
              .filter((d): d is string => Boolean(d)),
          ),
        ],
        confidence: authored.confidence,
        authored_at: new Date().toISOString(),
        model: opts.model ?? null,
        prompt_version: AUTHOR_PROMPT_VERSION,
        tool_version: opts.toolVersion,
        generation: opts.generation,
        // Coverage provenance: 1 when every member byte reached the model;
        // < 1 with the exact cuts listed when --truncate=extreme trimmed input.
        input_coverage: inputCoverage,
        truncations,
      };

      mkdirPrivate(dir);
      const oneshot = `${provenanceComment(sources)}\n\n# ${authored.title}\n\n${authored.oneshot_markdown.trim()}\n`;
      // Hash of the exact bytes written — the anchor for detecting user edits
      // (overwrite protection). Recorded in sources.json, not the file.
      sources.oneshot_hash = oneshotHash(oneshot);
      writeFilePrivate(path.join(dir, `${task.slug}.oneshot.md`), oneshot);
      writeFilePrivate(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);

      result.authored.push(task.slug);
      write(
        `      → ${authored.confidence} confidence, ${authored.preferences.length} preference(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ export: task.slug, error: message });
      write(`      ${fail(`failed: ${truncate(message, 120)}`)}`);
      // one task's failure doesn't abort the rest
    }
  };

  // Bounded worker pool: N workers pull the next un-started task until none
  // remain. concurrency=1 degrades to the exact sequential behavior. Each task
  // writes its own library/<slug>/ dir and the runner is stateless per call, so
  // parallel authoring is race-free; result.* pushes are synchronous (single JS
  // tick) so concurrent workers never interleave a mutation.
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < opts.tasks.length) {
      const i = nextIndex++;
      const task = opts.tasks[i];
      if (task) await authorOne(task, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()),
  );

  // Determinism: workers finish in nondeterministic order under concurrency > 1,
  // so re-order every result list by the task's original position. The report
  // (and any downstream consumer) then reads identically regardless of timing.
  const order = new Map(opts.tasks.map((t, i) => [t.slug, i]));
  const bySlug = (a: { slug: string }, b: { slug: string }) =>
    (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0);
  const byExport = (a: { export: string }, b: { export: string }) =>
    (order.get(a.export) ?? 0) - (order.get(b.export) ?? 0);
  result.authored.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  result.resumed.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  result.skipped.sort(bySlug);
  result.failed.sort(byExport);

  return result;
}
