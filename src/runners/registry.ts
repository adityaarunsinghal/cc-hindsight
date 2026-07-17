import { CLAUDE_INSTALL_HINT, claudeRunner } from "./claude.js";
import { KIRO_INSTALL_HINT, kiroRunner, makeKiroRunner } from "./kiro.js";
import { AgentRunnerError, defaultIo, type RunnerIo } from "./shared.js";
import type { AgentRunner } from "./types.js";

/**
 * runners/registry.ts — resolve which agent CLI distills.
 *
 * The runner (which CLI produces digests/clusters/oneshots) is orthogonal to
 * the source (where transcripts are read): a user can mine kiro history but
 * distill with claude, or vice-versa. `--runner` defaults to `auto`, which
 * prefers the CLI matching the active source and falls back to whichever binary
 * is installed — so a kiro-only machine works out of the box.
 */

export type RunnerMode = "claude" | "kiro" | "auto";

/** Parse/validate a raw `--runner` value; defaults to `auto`. */
export function parseRunnerMode(raw: string | undefined): RunnerMode {
  const value = (raw ?? "auto").toLowerCase();
  if (value === "auto" || value === "claude" || value === "kiro") return value;
  throw new Error(`unknown --runner "${raw}" (expected claude, kiro, or auto)`);
}

/** Options for {@link resolveRunner}. */
export interface ResolveRunnerOptions {
  /** Prefer the runner matching the active source under `auto`. */
  preferSource?: "claude" | "kiro";
  /** Injectable binary lookup/spawn (testing). */
  io?: RunnerIo;
  /**
   * Base directory for the kiro runner's per-run scratch cwd (the distill
   * home's `runner-scratch/`); absent falls back to the OS temp dir.
   */
  scratchBase?: string;
}

/**
 * Resolve the runner. EXPLICIT modes require that binary: a missing one throws
 * a typed `missing-binary` {@link AgentRunnerError} with the backend's install
 * hint at RESOLVE time — before any consent prompt, so the user learns the CLI
 * is absent before being asked to approve spending. `auto` prefers the runner
 * whose name matches `preferSource` when installed, else the first installed of
 * claude→kiro; if neither binary is found it returns the claude runner so the
 * standard missing-binary hint surfaces on first use.
 */
export async function resolveRunner(
  mode: RunnerMode,
  opts: ResolveRunnerOptions = {},
): Promise<AgentRunner> {
  const io = opts.io ?? defaultIo;
  const has = async (bin: string) => (await io.which(bin)) !== null;
  const kiro = () => (opts.scratchBase ? makeKiroRunner(undefined, opts.scratchBase) : kiroRunner);

  if (mode === "claude") {
    if (!(await has("claude"))) throw new AgentRunnerError("missing-binary", CLAUDE_INSTALL_HINT);
    return claudeRunner;
  }
  if (mode === "kiro") {
    if (!(await has("kiro-cli"))) throw new AgentRunnerError("missing-binary", KIRO_INSTALL_HINT);
    return kiro();
  }

  // auto — prefer the runner matching the active source when it is installed.
  if (opts.preferSource === "kiro" && (await has("kiro-cli"))) return kiro();
  if (opts.preferSource === "claude" && (await has("claude"))) return claudeRunner;
  // Otherwise first installed of claude → kiro.
  if (await has("claude")) return claudeRunner;
  if (await has("kiro-cli")) return kiro();
  // Neither found: return claude so its install hint surfaces on use.
  return claudeRunner;
}
