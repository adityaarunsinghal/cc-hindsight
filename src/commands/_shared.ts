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
  "kiro-dir": {
    type: "string",
    description: "kiro-cli config directory (env KIRO_CONFIG_DIR; default ~/.kiro)",
  },
  source: {
    type: "string",
    // Unlike the path flags above, this one has no environment variable, so the
    // root-level publish in main.ts cannot carry it into a subcommand: citty
    // gives a subcommand only its OWN parsed args. Say so rather than advertise
    // a placement that is silently ignored.
    description:
      "Which backend(s) to read: claude, kiro, or auto (default: auto). Pass after the subcommand",
  },
} as const;

export interface ResolvedPaths {
  home: string;
  claudeDir: string;
  kiroDir: string;
}

/**
 * Resolve data directories: flag > env > default under os.homedir(). The
 * `kiro-dir` points at the kiro CONFIG root (sessions are read from
 * `<kiroDir>/sessions/cli`), parallel to `--claude-dir`.
 */
export function resolvePaths(args: {
  home?: string;
  "claude-dir"?: string;
  "kiro-dir"?: string;
}): ResolvedPaths {
  const home =
    args.home ?? process.env.CC_HINDSIGHT_HOME ?? path.join(os.homedir(), ".cc-hindsight");
  const claudeDir =
    args["claude-dir"] ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const kiroDir =
    args["kiro-dir"] ?? process.env.KIRO_CONFIG_DIR ?? path.join(os.homedir(), ".kiro");
  return { home, claudeDir, kiroDir };
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
