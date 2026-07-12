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
