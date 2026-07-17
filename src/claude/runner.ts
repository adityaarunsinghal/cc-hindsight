/**
 * claude/runner.ts — compatibility shim.
 *
 * The claude runner split into `src/runners/shared.ts` (IO, spawn, errors,
 * retry primitives) + `src/runners/claude.ts` (envelope, args, probe, runClaude)
 * when cc-hindsight grew a multi-backend seam. This shim re-exports both halves
 * so existing imports of `claude/runner.js` keep working unchanged, including
 * the `ClaudeRunnerError` name (a class alias of `AgentRunnerError`, so
 * `instanceof` still holds).
 */

export {
  CLAUDE_INSTALL_HINT,
  type ClaudeErrorKind,
  ClaudeRunnerError,
  probeCapabilities,
  type RunClaudeOptions,
  resetCapabilityCache,
  runClaude,
} from "../runners/claude.js";
export {
  DEFAULT_TIMEOUT_MS,
  defaultIo,
  KILL_GRACE_MS,
  type RunnerIo,
  type SpawnOptions,
  type SpawnResult,
} from "../runners/shared.js";
export type { Capabilities } from "../runners/types.js";
