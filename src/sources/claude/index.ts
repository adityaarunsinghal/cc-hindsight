/**
 * sources/claude/index.ts — the Claude Code backend as a SessionSource.
 *
 * Binds a claude config dir to the moved discover/extract/timeline functions.
 * Claude classifies human-vs-machine per-entry inside `extract` (R2), so it
 * exposes no session-level `classify`.
 */

import type { ProjectInfo, SessionSource } from "../types.js";
import { discoverProjects } from "./discover.js";
import { extractMessages, extractTimeline } from "./extract.js";

/** Construct the Claude Code source bound to a config directory. */
export function claudeSource(claudeDir: string): SessionSource {
  return {
    name: "claude",
    discover(opts?: { countEntries?: boolean }): ProjectInfo[] {
      return discoverProjects(claudeDir, opts);
    },
    extract: extractMessages,
    timeline: extractTimeline,
  };
}
