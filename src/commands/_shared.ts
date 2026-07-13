import os from "node:os";
import path from "node:path";

/** Global flags shared by every subcommand. */
export const sharedArgs = {
  home: {
    type: "string",
    description: "cc-hindsight data directory (env CC_HINDSIGHT_HOME)",
  },
  "claude-dir": {
    type: "string",
    description: "Claude Code config directory (env CLAUDE_CONFIG_DIR)",
  },
} as const;

export interface ResolvedPaths {
  home: string;
  claudeDir: string;
}

/** Resolve data directories: flag > env > default under os.homedir(). */
export function resolvePaths(args: { home?: string; "claude-dir"?: string }): ResolvedPaths {
  const home =
    args.home ?? process.env.CC_HINDSIGHT_HOME ?? path.join(os.homedir(), ".cc-hindsight");
  const claudeDir =
    args["claude-dir"] ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return { home, claudeDir };
}

/**
 * Parse a non-negative integer CLI flag, clamping deterministically: a missing
 * or unparseable value yields `fallback`; a parsed value below `min` clamps up
 * to `min`. Shared by `export --min-messages` and `distill --min-substance` so
 * the two commands can never diverge. The naive `parseInt(...) || fallback`
 * has two traps this avoids: it maps a legitimate "0" to the fallback, and it
 * lets "-1" through as "everything is eligible".
 */
export function parseClampedInt(
  raw: string | undefined,
  opts: { fallback: number; min: number },
): number {
  if (raw === undefined) return opts.fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return opts.fallback;
  return parsed < opts.min ? opts.min : parsed;
}
