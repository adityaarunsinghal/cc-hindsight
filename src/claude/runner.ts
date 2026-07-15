import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import { toJsonSchema } from "./schemas.js";

/**
 * The safe bridge to the local `claude` CLI.
 *
 * All process interaction lives behind the injectable {@link RunnerIo}
 * interface so unit tests can mock spawning entirely and never invoke the real
 * binary. The default IO uses `node:child_process` + a PATH scan.
 *
 * Verified against Claude Code CLI 2.1.207 (macOS):
 *   - `claude -p --output-format json`  → single JSON envelope on stdout
 *     ({ type, subtype, is_error, result, session_id, total_cost_usd, usage, ... });
 *     `result` carries the model's text output.
 *   - `--json-schema <json>`            → server-side structured-output validation.
 *   - `--tools ""`                      → disable all built-in tools.
 *   - `--model <name>`                  → model pass-through.
 * Older CLIs may lack `--json-schema`; the capability probe detects it and we
 * fall back to embedding the schema in the prompt + zod validation.
 */

/** Pointer shown when the `claude` binary cannot be found on PATH. */
export const CLAUDE_INSTALL_HINT =
  "`claude` CLI not found on PATH. Install it with `npm install -g @anthropic-ai/claude-code` " +
  "(docs: https://docs.claude.com/en/docs/claude-code). Deterministic commands (scan/export) " +
  "work without it — only distill needs claude.";

/** Default per-invocation timeout: 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Kinds of failure the runner can raise, for typed handling upstream. */
export type ClaudeErrorKind = "missing-binary" | "timeout" | "cli-error" | "validation";

/** A typed error carrying enough context (stderr / output snippet) to report. */
export class ClaudeRunnerError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly stderr?: string;
  readonly output?: string;

  constructor(
    kind: ClaudeErrorKind,
    message: string,
    extra?: { stderr?: string; output?: string },
  ) {
    super(message);
    this.name = "ClaudeRunnerError";
    this.kind = kind;
    this.stderr = extra?.stderr;
    this.output = extra?.output;
  }
}

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

/** What the installed CLI supports, discovered once per process via probe. */
export interface Capabilities {
  /** Whether `--json-schema` is accepted (server-side structured output). */
  jsonSchema: boolean;
  /** How to disable tool use: `--tools ""`, deny-list, or instruction-only. */
  disableTools: "tools-empty" | "disallowed" | "none";
}

/** Options for a single stage invocation. */
export interface RunClaudeOptions<T> {
  /** The stage prompt; delivered on stdin. */
  prompt: string;
  /** The zod schema the response must satisfy (source of truth). */
  schema: ZodType<T>;
  /** `--model` pass-through. */
  model?: string;
  /** Per-invocation timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Disable tool use (default true — distill stages need no tools). */
  disableTools?: boolean;
  /** Skip the capability probe by supplying capabilities directly (testing). */
  capabilities?: Capabilities;
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

/** Grace period between SIGTERM and SIGKILL on timeout. */
export const KILL_GRACE_MS = 2_000;

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

    // If `claude` exits early (auth error, bad flags, crash) while a large prompt
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

// --- capability probe (cached once per process) ---------------------------

let capabilitiesCache: Capabilities | null = null;

/** Reset the process-level capability cache (tests only). */
export function resetCapabilityCache(): void {
  capabilitiesCache = null;
}

/**
 * Probe the installed CLI's `--help` once and cache the result. `--help` is a
 * local, deterministic, no-API invocation, so this never costs anything.
 */
export async function probeCapabilities(bin: string, io: RunnerIo): Promise<Capabilities> {
  if (capabilitiesCache) return capabilitiesCache;
  const help = await io.spawn(bin, ["--help"], { input: "", timeoutMs: 15_000 });
  const text = `${help.stdout}\n${help.stderr}`;
  const disableTools: Capabilities["disableTools"] = text.includes("--tools")
    ? "tools-empty"
    : /--disallowed-?[tT]ools/.test(text)
      ? "disallowed"
      : "none";
  const caps: Capabilities = {
    jsonSchema: text.includes("--json-schema"),
    disableTools,
  };
  capabilitiesCache = caps;
  return caps;
}

// --- envelope parsing ------------------------------------------------------

/** Minimal shape of the `claude -p --output-format json` envelope. */
interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  [k: string]: unknown;
}

/** Internal sentinel: a parse/validation problem that warrants one retry. */
class RetryableError extends Error {}

function snippet(s: string, max = 500): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Strip a Markdown code fence if the model wrapped its JSON in one. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fence?.[1] ? fence[1].trim() : trimmed;
}

/**
 * Parse the CLI envelope and pull out the structured result. Throws
 * {@link ClaudeRunnerError} for fatal CLI errors (no point retrying) and
 * {@link RetryableError} for parse/validation problems (retry may help).
 */
function extractResult(result: SpawnResult): unknown {
  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
  } catch {
    // No parseable envelope. A non-zero exit means the CLI itself failed
    // (auth, bad flags) — fatal. Otherwise the output is just malformed — retry.
    const detail = snippet(result.stdout || result.stderr) || "no output";
    if (result.code !== 0) {
      throw new ClaudeRunnerError("cli-error", `claude exited ${result.code}: ${detail}`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    throw new RetryableError(`could not parse claude JSON envelope: ${detail}`);
  }

  if (envelope.is_error) {
    const msg = typeof envelope.result === "string" ? envelope.result : "unknown error";
    throw new ClaudeRunnerError("cli-error", `claude reported an error: ${msg}`, {
      stderr: result.stderr,
      output: result.stdout,
    });
  }

  const r = envelope.result;
  if (r === null || r === undefined) {
    throw new RetryableError("claude envelope missing a 'result' field");
  }
  // With --json-schema the CLI may hand back an already-structured object.
  if (typeof r === "object") return r;
  if (typeof r === "string") {
    const jsonText = stripFence(r);
    try {
      return JSON.parse(jsonText);
    } catch {
      throw new RetryableError(`claude result was not valid JSON: ${snippet(r)}`);
    }
  }
  throw new RetryableError(`unexpected claude result type: ${typeof r}`);
}

// --- invocation ------------------------------------------------------------

function buildArgs(caps: Capabilities, opts: RunClaudeOptions<unknown>): string[] {
  const args = ["-p", "--output-format", "json"];
  if (caps.jsonSchema) {
    args.push("--json-schema", JSON.stringify(toJsonSchema(opts.schema)));
  }
  const disableTools = opts.disableTools ?? true;
  if (disableTools && caps.disableTools === "tools-empty") {
    args.push("--tools", "");
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  return args;
}

function buildPrompt(caps: Capabilities, opts: RunClaudeOptions<unknown>): string {
  let prompt = opts.prompt;
  // Fallback when the CLI can't validate against a schema itself.
  if (!caps.jsonSchema) {
    const json = JSON.stringify(toJsonSchema(opts.schema));
    prompt += `\n\nRespond ONLY with JSON matching this schema:\n${json}`;
  }
  // Instruction-level tool disabling whenever we can't do it with the `--tools`
  // flag. Covers BOTH "none" (no tool flag at all) AND "disallowed": a CLI that
  // advertises only `--disallowedTools` has no portable deny-ALL value across
  // versions, so the flag path can't be relied on — the instruction is always
  // honored by the model. Leaving "disallowed" with neither flag nor
  // instruction would silently run distill stages with tools enabled.
  const disableTools = opts.disableTools ?? true;
  if (disableTools && caps.disableTools !== "tools-empty") {
    prompt += "\n\nDo not use any tools; answer directly from the content provided.";
  }
  return prompt;
}

async function resolveBinary(io: RunnerIo): Promise<string> {
  const resolved = await io.which("claude");
  if (!resolved) {
    throw new ClaudeRunnerError("missing-binary", CLAUDE_INSTALL_HINT);
  }
  return resolved;
}

/**
 * Invoke `claude -p` for one stage: resolve the binary, probe capabilities
 * (cached), spawn with the schema flag (or embed it in the prompt), parse the
 * envelope, validate against the zod schema, and retry exactly once on a
 * parse/validation failure with a corrective note. Throws a typed
 * {@link ClaudeRunnerError} on missing binary, timeout, CLI error, or a second
 * validation failure.
 */
export async function runClaude<T>(
  opts: RunClaudeOptions<T>,
  io: RunnerIo = defaultIo,
): Promise<T> {
  const bin = await resolveBinary(io);
  const caps = opts.capabilities ?? (await probeCapabilities(bin, io));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = buildArgs(caps, opts);
  const basePrompt = buildPrompt(caps, opts);

  let lastDetail = "";
  let lastOutput = "";
  let lastStderr = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    let input = basePrompt;
    if (attempt === 1) {
      input += `\n\nYour previous response could not be used (${lastDetail}). Respond ONLY with valid JSON matching the required schema — no prose, no code fences.`;
    }

    const result = await io.spawn(bin, args, { input, timeoutMs });
    if (result.timedOut) {
      throw new ClaudeRunnerError("timeout", `claude invocation timed out after ${timeoutMs}ms`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    lastOutput = result.stdout;
    lastStderr = result.stderr;

    try {
      const raw = extractResult(result);
      return opts.schema.parse(raw);
    } catch (err) {
      if (err instanceof ClaudeRunnerError) throw err; // fatal — do not retry
      lastDetail = err instanceof Error ? err.message : String(err);
      // fall through to retry / final throw
    }
  }

  throw new ClaudeRunnerError(
    "validation",
    `claude response failed schema validation after one retry: ${lastDetail}`,
    { stderr: lastStderr, output: lastOutput },
  );
}
