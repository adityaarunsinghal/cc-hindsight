import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
    const child = nodeSpawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
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

/** Strip a Markdown code fence if the model wrapped its JSON in one. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fence?.[1] ? fence[1].trim() : trimmed;
}
