import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import type { RunnerErrorKind } from "./types.js";

/**
 * runners/shared.ts — backend-agnostic runner plumbing.
 *
 * Everything here is independent of which agent CLI is being driven: process
 * spawning behind the injectable {@link RunnerIo}, the typed error, the internal
 * retry sentinel, and the small text helpers. Split out of the original
 * `src/claude/runner.ts` so the claude and kiro runners share one IO/error
 * layer. A shim at `src/claude/runner.ts` re-exports these for old imports.
 */

/** Default per-invocation timeout: 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Grace period between SIGTERM and SIGKILL on timeout. */
export const KILL_GRACE_MS = 2_000;

/** A typed error carrying enough context (stderr / output snippet) to report. */
export class AgentRunnerError extends Error {
  readonly kind: RunnerErrorKind;
  readonly stderr?: string;
  readonly output?: string;

  constructor(
    kind: RunnerErrorKind,
    message: string,
    extra?: { stderr?: string; output?: string },
  ) {
    super(message);
    this.name = "AgentRunnerError";
    this.kind = kind;
    this.stderr = extra?.stderr;
    this.output = extra?.output;
  }
}

/** Internal sentinel: a parse/validation problem that warrants one retry. */
export class RetryableError extends Error {}

/** Result of spawning a process: captured output plus how it ended. */
export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed because it exceeded the timeout. */
  timedOut: boolean;
}

/** Options passed to {@link RunnerIo.spawn}. */
export interface SpawnOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input: string;
  timeoutMs: number;
  /**
   * Working directory for the child (default: inherit). The kiro runner spawns
   * from a per-run scratch cwd so its local agent config is discovered and its
   * auto-saved sessions are isolated for cleanup; the claude runner never sets it.
   */
  cwd?: string;
}

/** All process interaction the runner needs — injectable for testing. */
export interface RunnerIo {
  /** Resolve a binary on PATH; return its absolute path or null if not found. */
  which(bin: string): Promise<string | null> | string | null;
  /** Spawn a process, feed stdin, and resolve with captured output. */
  spawn(bin: string, args: string[], opts: SpawnOptions): Promise<SpawnResult>;
}

// --- default IO (real node:child_process + PATH scan) ---------------------

function defaultWhich(bin: string): string | null {
  const envPath = process.env.PATH ?? "";
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // not here; keep scanning
      }
    }
  }
  return null;
}

function defaultSpawn(bin: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      // Ask politely first so the child can flush; force-kill only if it lingers.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.(); // never keep the event loop alive on our account
    }, opts.timeoutMs);

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimers();
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    // If the CLI exits early (auth error, bad flags, crash) while a large prompt
    // is still buffered, writing to its stdin raises EPIPE. With no listener that
    // becomes an uncaught exception and takes the whole process down mid-distill,
    // bypassing the per-session failure containment. Swallow it: the `close`
    // handler already reports the real failure via exit code + stderr.
    child.stdin?.on("error", () => {});
    child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

/** The default IO, used when none is injected. */
export const defaultIo: RunnerIo = {
  which: defaultWhich,
  spawn: defaultSpawn,
};

// --- text helpers ----------------------------------------------------------

/** Whitespace-trim and cap a string for an error/report snippet. */
export function snippet(s: string, max = 500): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Strip a Markdown code fence if the model wrapped its JSON in one.
 *
 * This is the last line of defense on the schema-in-prompt path (no
 * `--json-schema`, and the kiro runner always): the model's raw text is all we
 * get, and a fence we fail to strip becomes a JSON parse error that burns the
 * one corrective retry. Verified against the live CLI on that path: the model
 * really does answer with a ```json fence even when told to respond ONLY with
 * JSON, so the neighboring shapes are worth tolerating too.
 *
 * The anchored form only matched a fence that was the WHOLE string, so a single
 * "Here you go:" preamble or "Hope that helps!" sign-off defeated it, as did an
 * uppercase ```JSON tag (which got captured into the body). Now: find the first
 * fenced block anywhere in the text, case-insensitively; fall back to the
 * trimmed text so non-fenced input and unterminated fences pass through
 * unchanged and the caller can report the real content in its snippet.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  // Non-anchored so surrounding prose is tolerated; `i` for ```JSON; the lazy
  // body plus the first-match semantics of `match` take the FIRST block when a
  // model emits several.
  const fence = trimmed.match(/```[a-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```/i);
  const body = fence?.[1]?.trim();
  return body ? body : trimmed;
}

// --- shared prompt/retry machinery -----------------------------------------

/**
 * Append the JSON schema to a prompt for backends that cannot validate
 * server-side: claude uses it when the capability probe finds no
 * `--json-schema`; kiro uses it always (no envelope, no server-side schema).
 */
export function embedSchema(prompt: string, schemaJson: string): string {
  return `${prompt}\n\nRespond ONLY with JSON matching this schema:\n${schemaJson}`;
}

/** The corrective note appended to the prompt on the single validation retry. */
export function correctiveNote(detail: string): string {
  return `\n\nYour previous response could not be used (${detail}). Respond ONLY with valid JSON matching the required schema — no prose, no code fences.`;
}

/**
 * The shared corrective-retry loop (both runners): run one backend-specific
 * attempt (spawn + parse to a raw JSON value), validate against the zod
 * schema, and on a parse/validation problem retry EXACTLY ONCE with the
 * corrective note appended to the prompt. An {@link AgentRunnerError} from the
 * attempt is fatal (missing binary, timeout, CLI error — a retry cannot help);
 * anything else (RetryableError, zod failure) feeds the note. Exhaustion
 * throws via `makeExhaustedError` so each backend keeps its exact error copy.
 */
export async function runWithCorrectiveRetry<T>(
  basePrompt: string,
  schema: ZodType<T>,
  attemptFn: (input: string) => Promise<unknown>,
  makeExhaustedError: (lastDetail: string) => AgentRunnerError,
): Promise<T> {
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = attempt === 0 ? basePrompt : basePrompt + correctiveNote(lastDetail);
    try {
      const raw = await attemptFn(input);
      return schema.parse(raw);
    } catch (err) {
      if (err instanceof AgentRunnerError) throw err; // fatal — do not retry
      lastDetail = err instanceof Error ? err.message : String(err);
    }
  }
  throw makeExhaustedError(lastDetail);
}
