import { toJsonSchema } from "../claude/schemas.js";
import {
  AgentRunnerError,
  DEFAULT_TIMEOUT_MS,
  defaultIo,
  embedSchema,
  RetryableError,
  type RunnerIo,
  runWithCorrectiveRetry,
  type SpawnResult,
  snippet,
  stripFence,
} from "./shared.js";
import type { AgentRunner, Capabilities, RunnerErrorKind, RunOptions } from "./types.js";

/**
 * runners/claude.ts — the claude-CLI-specific runner.
 * (Split from src/claude/runner.ts; shared IO/error/retry primitives live in
 * runners/shared.ts. A shim at src/claude/runner.ts re-exports both halves,
 * including a `ClaudeRunnerError` class alias so `instanceof` keeps working.)
 *
 * Verified against Claude Code CLI 2.1.207 (macOS) and 2.1.220 (Linux):
 *   - `claude -p --output-format json`  → single JSON envelope on stdout
 *     ({ type, subtype, is_error, result, session_id, total_cost_usd, usage, ... });
 *     `result` carries the model's text output. With verbose mode ON stdout is
 *     instead a JSON ARRAY of stream events terminated by the `type: "result"`
 *     event; both shapes are accepted (see `selectEnvelope`).
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

/**
 * Alias preserved for callers/tests that referenced the claude-specific error.
 * Declaration-merged as both a value (the class constructor, so `instanceof`
 * works) and a type (the instance type, so `e as ClaudeRunnerError` compiles).
 */
export const ClaudeRunnerError = AgentRunnerError;
export type ClaudeRunnerError = AgentRunnerError;
export type ClaudeErrorKind = RunnerErrorKind;

/** Options for a single claude stage invocation (kept name for compatibility). */
export type RunClaudeOptions<T> = RunOptions<T>;

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

/**
 * Minimal shape of the `claude -p --output-format json` envelope. Verbose mode
 * emits an ARRAY of these (stream events) instead of one object; see
 * {@link selectEnvelope}.
 */
interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  [k: string]: unknown;
}

/**
 * Reduce a verbose-mode payload to the single envelope carrying the result.
 *
 * With verbose mode ON (`--verbose`, or `"verbose": true` in settings.json)
 * `claude -p --output-format json` emits a JSON ARRAY of stream events
 * (`system`/init, `assistant`, …) terminated by the `type: "result"` event,
 * instead of the single result object it emits when verbose is off. Only the
 * terminal event has `result`/`is_error`, so reading the array as an object
 * finds no `result` field and every call fails. The CLI has no `--no-verbose`
 * to force the object shape, so both shapes must be accepted.
 *
 * The result event is located by its `type` field (its key ORDER is not stable:
 * on a real 2.1.220 run `type` is the 19th key), with a positional
 * last-element fallback for a future stream that renames the type tag.
 */
function selectEnvelope(parsed: unknown): ClaudeEnvelope | null {
  if (!Array.isArray(parsed)) return parsed as ClaudeEnvelope;
  const events = parsed as ClaudeEnvelope[];
  const resultEvent = events.findLast((e) => e?.type === "result");
  if (resultEvent) return resultEvent;
  // No type-tagged result event: fall back to the last element if it at least
  // looks like a terminal envelope, else signal "no result event" to the caller.
  const last = events.at(-1);
  if (last && (Object.hasOwn(last, "result") || Object.hasOwn(last, "is_error"))) return last;
  return null;
}

/**
 * Parse the CLI envelope and pull out the structured result. Throws
 * {@link AgentRunnerError} for fatal CLI errors (no point retrying) and
 * {@link RetryableError} for parse/validation problems (retry may help).
 */
function extractResult(result: SpawnResult): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // No parseable envelope. A non-zero exit means the CLI itself failed
    // (auth, bad flags) — fatal. Otherwise the output is just malformed — retry.
    const detail = snippet(result.stdout || result.stderr) || "no output";
    if (result.code !== 0) {
      throw new AgentRunnerError("cli-error", `claude exited ${result.code}: ${detail}`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    throw new RetryableError(`could not parse claude JSON envelope: ${detail}`);
  }

  const envelope = selectEnvelope(parsed);
  if (!envelope) {
    // A verbose stream that ended without its terminal event (interrupted or
    // truncated). Name the real problem so it is diagnosable from the report.
    throw new RetryableError(
      `claude verbose stream carried no 'result' event: ${snippet(result.stdout) || "empty array"}`,
    );
  }

  if (envelope.is_error) {
    const msg = typeof envelope.result === "string" ? envelope.result : "unknown error";
    throw new AgentRunnerError("cli-error", `claude reported an error: ${msg}`, {
      stderr: result.stderr,
      output: result.stdout,
    });
  }

  const r = envelope.result;
  if (r === null || r === undefined) {
    // Include a snippet: a bare "missing a 'result' field" is undiagnosable, and
    // that opacity is what hid the verbose-array shape for a whole release.
    throw new RetryableError(
      `claude envelope missing a 'result' field: ${snippet(result.stdout, 200) || "no output"}`,
    );
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
  // Fallback when the CLI can't validate against a schema itself (shared with
  // the kiro runner, which embeds always).
  if (!caps.jsonSchema) {
    prompt = embedSchema(prompt, JSON.stringify(toJsonSchema(opts.schema)));
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
    throw new AgentRunnerError("missing-binary", CLAUDE_INSTALL_HINT);
  }
  return resolved;
}

/**
 * Invoke `claude -p` for one stage: resolve the binary, probe capabilities
 * (cached), spawn with the schema flag (or embed it in the prompt), parse the
 * envelope, validate against the zod schema, and retry exactly once on a
 * parse/validation failure with a corrective note. Throws a typed
 * {@link AgentRunnerError} on missing binary, timeout, CLI error, or a second
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

  // Captured by the attempt closure so the exhaustion error carries the last
  // spawn's stderr/stdout for reporting (behavior identical to the pre-seam
  // inline loop).
  let lastOutput = "";
  let lastStderr = "";

  return runWithCorrectiveRetry(
    buildPrompt(caps, opts),
    opts.schema,
    async (input) => {
      const result = await io.spawn(bin, args, { input, timeoutMs });
      if (result.timedOut) {
        throw new AgentRunnerError("timeout", `claude invocation timed out after ${timeoutMs}ms`, {
          stderr: result.stderr,
          output: result.stdout,
        });
      }
      lastOutput = result.stdout;
      lastStderr = result.stderr;
      return extractResult(result);
    },
    (lastDetail) =>
      new AgentRunnerError(
        "validation",
        `claude response failed schema validation after one retry: ${lastDetail}`,
        { stderr: lastStderr, output: lastOutput },
      ),
  );
}

/** The Claude Code backend as an {@link AgentRunner}. */
export const claudeRunner: AgentRunner = {
  name: "claude",
  installHint: CLAUDE_INSTALL_HINT,
  run: (opts) => runClaude(opts),
};
