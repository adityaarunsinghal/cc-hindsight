import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo, SessionInfo } from "../types.js";

/**
 * sources/claude/discover.ts — enumerate Claude Code projects/sessions.
 * (Moved from src/core/discover.ts; a re-export shim keeps the old import path
 * working. `SessionInfo`/`ProjectInfo` now live in sources/types.ts.)
 */

export type { ProjectInfo, SessionInfo } from "../types.js";

/**
 * Decode a dash-encoded Claude Code project directory name back into a path.
 *
 * Claude Code names each project directory after the project's absolute path,
 * replacing every path separator (and some other characters, like `.`) with a
 * dash — so `/Users/alice/projects/webapp` becomes
 * `-Users-alice-projects-webapp`.
 *
 * The transform is **lossy and cannot be perfectly inverted**: a directory
 * literally named `my-app` encodes to the exact same string as the nested path
 * `my/app`. This is therefore a *documented best-effort heuristic*:
 *
 *   - a leading dash denotes the filesystem root `/`;
 *   - every remaining dash becomes a path separator;
 *   - empty segments (from runs of dashes, e.g. an encoded `.`) are dropped.
 *
 * Consequently a real directory name containing a dash will be split into extra
 * path segments; callers get the last segment as the short name regardless, so
 * this degrades gracefully rather than failing.
 */
export function decodeProjectDir(dirName: string): string {
  const rooted = dirName.startsWith("-");
  const body = rooted ? dirName.slice(1) : dirName;
  const segments = body.split("-").filter((s) => s.length > 0);
  const joined = segments.join("/");
  return rooted ? `/${joined}` : joined;
}

/**
 * Enumerate every Claude Code project and its top-level sessions under
 * `<claudeDir>/projects`.
 *
 * - Only top-level `*.jsonl` files count as sessions; nested subdirectories
 *   (e.g. subagent/sidechain threads) are intentionally excluded.
 * - A missing or empty `projects` directory yields an empty array (never
 *   throws).
 * - Unreadable files/directories are skipped, not fatal.
 * - Short names are derived from the decoded path's last segment and
 *   deduplicated deterministically (`name`, `name-2`, `name-3`, …).
 *
 * The result is sorted by `dirName` for a stable, deterministic ordering.
 */
export function discoverProjects(
  claudeDir: string,
  opts: { countEntries?: boolean } = {},
): ProjectInfo[] {
  const projectsRoot = path.join(claudeDir, "projects");
  const countEntriesOpt = opts.countEntries ?? true;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    // Missing/unreadable projects directory → nothing to inventory.
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dirName = dirent.name;
    const projectDir = path.join(projectsRoot, dirName);
    const sessions = readSessions(projectDir, countEntriesOpt);
    const decodedPath = decodeProjectDir(dirName);
    // Short name = last path segment of the decoded path. `path.posix` because
    // decoded paths always use `/` separators regardless of host platform.
    const shortName = path.posix.basename(decodedPath) || dirName;
    const entryTotal = sessions.reduce((sum, s) => sum + s.entryCount, 0);
    const latestMtime = sessions.length > 0 ? sessions[0]?.mtime : undefined;
    projects.push({ dirName, decodedPath, shortName, sessions, entryTotal, latestMtime });
  }

  // Deterministic ordering, then deterministic short-name disambiguation.
  projects.sort((a, b) => a.dirName.localeCompare(b.dirName));
  disambiguateShortNames(projects);
  return projects;
}

/**
 * List top-level `*.jsonl` sessions in a project dir, newest first.
 *
 * `countEntries` controls whether each file is read to compute {@link
 * SessionInfo.entryCount}: `scan` wants the number (its inventory column), but
 * `export`/`status` never use it and would otherwise pay a full-file read here
 * AND again when reading content — a wasteful double read on large trees.
 * When disabled, `entryCount` is 0 and only cheap `stat` metadata is read.
 */
function readSessions(projectDir: string, countEntries: boolean): SessionInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const entry of entries) {
    // Top-level regular files only. Nested subdirectories (subagent threads)
    // are excluded by not recursing and by requiring isFile().
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;

    const filePath = path.join(projectDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Unreadable session file: skip it (do not abort the whole scan).
      continue;
    }

    sessions.push({
      file: entry.name,
      path: filePath,
      entryCount: countEntries ? countFileEntries(filePath) : 0,
      mtime: stat.mtime,
    });
  }

  // Newest first; tie-break on file name for determinism.
  sessions.sort((a, b) => {
    const diff = b.mtime.getTime() - a.mtime.getTime();
    return diff !== 0 ? diff : a.file.localeCompare(b.file);
  });
  return sessions;
}

/**
 * Count non-empty newline-delimited lines by reading the file in fixed-size
 * chunks, so a single huge session never materializes as one giant string in
 * memory. Semantics: a line is counted when it contains any non-whitespace
 * character. Unreadable → 0.
 */
function countFileEntries(filePath: string): number {
  const CHUNK = 64 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return 0;
  }
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let count = 0;
    let lineHasContent = false;
    let bytesRead: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard readSync loop
    while ((bytesRead = fs.readSync(fd, buffer, 0, CHUNK, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i];
        if (byte === 0x0a) {
          if (lineHasContent) count++; // end of a non-empty line
          lineHasContent = false;
        } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
          lineHasContent = true; // a non-whitespace byte on this line
        }
      }
    }
    if (lineHasContent) count++; // final line without a trailing newline
    return count;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Ensure short names are unique. The first project (by sorted `dirName`) keeps
 * the bare name; subsequent collisions get `-2`, `-3`, … appended. Deterministic
 * because the input is pre-sorted by `dirName`.
 */
function disambiguateShortNames(projects: ProjectInfo[]): void {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const base = project.shortName;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    if (seen > 0) project.shortName = `${base}-${seen + 1}`;
  }
}
