import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../claude/prompts/digest.js";
import { type RunClaudeOptions, runClaude } from "../claude/runner.js";
import { type Digest, DigestSchema } from "../claude/schemas.js";
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
