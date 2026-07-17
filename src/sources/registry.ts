import fs from "node:fs";
import path from "node:path";
import { claudeSource } from "./claude/index.js";
import { KIRO_SESSIONS_SUBDIR } from "./kiro/discover.js";
import { kiroSource } from "./kiro/index.js";
import type { SessionSource, SourceName } from "./types.js";

/**
 * sources/registry.ts — resolve `--source claude|kiro|auto` into the concrete
 * backends to run.
 *
 * - `claude` / `kiro`: exactly that one backend (even if its store is empty —
 *   an explicit choice is honored).
 * - `auto` (default): every backend whose on-disk store EXISTS and holds at
 *   least one project, in the fixed order claude-then-kiro. A machine with
 *   only one populated store gets exactly that one; a machine with neither
 *   gets an empty list (commands then report "nothing found" exactly as
 *   before). An existing-but-empty store contributes nothing, so it never
 *   pads stats breakdowns with zero entries.
 *
 * An unknown value throws — the caller maps that to exit 1.
 */

/** The `--source` selector; `auto` is the default. */
export type SourceMode = SourceName | "auto";

/** Directories a resolver needs to construct each backend. */
export interface SourceDirs {
  claudeDir: string;
  kiroDir: string;
}

/** True when a Claude Code store exists (a `projects` dir under claudeDir). */
function claudeStoreExists(claudeDir: string): boolean {
  try {
    return fs.statSync(path.join(claudeDir, "projects")).isDirectory();
  } catch {
    return false;
  }
}

/** True when a kiro store exists (a `sessions/cli` dir under kiroDir). */
function kiroStoreExists(kiroDir: string): boolean {
  try {
    return fs.statSync(path.join(kiroDir, KIRO_SESSIONS_SUBDIR)).isDirectory();
  } catch {
    return false;
  }
}

/** Parse/validate a raw `--source` flag value; defaults to `auto`. */
export function parseSourceMode(raw: string | undefined): SourceMode {
  const value = (raw ?? "auto").toLowerCase();
  if (value === "auto" || value === "claude" || value === "kiro") return value;
  throw new Error(`unknown --source "${raw}" (expected claude, kiro, or auto)`);
}

/**
 * Resolve the source mode into the ordered list of backends to run. `auto`
 * probes each store's existence AND requires it to discover at least one
 * project; explicit modes always return their one backend. Order is always
 * claude-then-kiro so merged output is deterministic.
 */
export function resolveSources(mode: SourceMode, dirs: SourceDirs): SessionSource[] {
  if (mode === "claude") return [claudeSource(dirs.claudeDir)];
  if (mode === "kiro") return [kiroSource(dirs.kiroDir)];

  // auto — include each backend whose store exists and holds ≥1 project (the
  // discover call is a cheap directory listing; countEntries stays off).
  const sources: SessionSource[] = [];
  if (claudeStoreExists(dirs.claudeDir)) {
    const claude = claudeSource(dirs.claudeDir);
    if (claude.discover({ countEntries: false }).length > 0) sources.push(claude);
  }
  if (kiroStoreExists(dirs.kiroDir)) {
    const kiro = kiroSource(dirs.kiroDir);
    if (kiro.discover({ countEntries: false }).length > 0) sources.push(kiro);
  }
  return sources;
}
