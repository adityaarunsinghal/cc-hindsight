import { claudeRunner } from "./claude.js";
import { kiroRunner } from "./kiro.js";
import { defaultIo, type RunnerIo } from "./shared.js";
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

/**
 * Resolve the runner. Explicit modes return that runner (its own missing-binary
 * error fires at call time). `auto` prefers the runner whose name matches
 * `preferSource` when set, else the first installed of claude→kiro; if neither
 * binary is found it returns the claude runner so the standard missing-binary
 * hint is shown.
 */
export async function resolveRunner(
  mode: RunnerMode,
  opts: { preferSource?: "claude" | "kiro"; io?: RunnerIo } = {},
): Promise<AgentRunner> {
  if (mode === "claude") return claudeRunner;
  if (mode === "kiro") return kiroRunner;

  const io = opts.io ?? defaultIo;
  // auto — prefer the runner matching the active source when it is installed.
  const has = async (bin: string) => (await io.which(bin)) !== null;
  if (opts.preferSource === "kiro" && (await has("kiro-cli"))) return kiroRunner;
  if (opts.preferSource === "claude" && (await has("claude"))) return claudeRunner;
  // Otherwise first installed of claude → kiro.
  if (await has("claude")) return claudeRunner;
  if (await has("kiro-cli")) return kiroRunner;
  // Neither found: return claude so its install hint surfaces on use.
  return claudeRunner;
}
