import type { ZodType } from "zod";

/**
 * runners/types.ts — the backend-agnostic runner contract.
 *
 * A runner is the safe bridge to ONE local agent CLI (claude, kiro-cli, …). It
 * takes a stage prompt + a zod schema and returns a validated object, hiding
 * all process interaction behind the injectable {@link RunnerIo} so tests never
 * spawn the real binary.
 */

/** Kinds of failure a runner can raise, for typed handling upstream. */
export type RunnerErrorKind = "missing-binary" | "timeout" | "cli-error" | "validation";

/** Options for a single stage invocation (backend-agnostic). */
export interface RunOptions<T> {
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

/**
 * What the installed CLI supports, discovered once per process via probe.
 * (Claude-shaped today; kiro fills a fixed no-schema shape.)
 */
export interface Capabilities {
  /** Whether `--json-schema` is accepted (server-side structured output). */
  jsonSchema: boolean;
  /** How to disable tool use: `--tools ""`, deny-list, or instruction-only. */
  disableTools: "tools-empty" | "disallowed" | "none";
}

/** A pluggable agent runner. */
export interface AgentRunner {
  readonly name: "claude" | "kiro";
  /** One-line install hint shown when the binary is missing. */
  readonly installHint: string;
  /** Invoke one stage: prompt+schema in, validated object out. */
  run<T>(opts: RunOptions<T>): Promise<T>;
}
