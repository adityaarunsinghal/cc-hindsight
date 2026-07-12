import fs from "node:fs";
import path from "node:path";

/** A single Claude Code session transcript file. */
export interface SessionInfo {
  /** File name on disk, e.g. `01ab...ef.jsonl`. */
  file: string;
  /** Absolute path to the session file. */
  path: string;
  /**
   * Cheap entry count: number of non-empty newline-delimited lines. Each JSONL
   * line is one transcript entry; we deliberately do NOT `JSON.parse` per line
   * (that would be O(entries) parses just to inventory the machine).
   */
  entryCount: number;
  /** File modification time — a proxy for "last touched". */
  mtime: Date;
}

/** A Claude Code project: one directory under `<claudeDir>/projects`. */
export interface ProjectInfo {
  /** Raw, dash-encoded directory name as it exists on disk. */
  dirName: string;
  /** Best-effort decoded filesystem path (see {@link decodeProjectDir}). */
  decodedPath: string;
  /**
   * Short, human-friendly name: the last segment of the decoded path,
   * deduplicated across the result set (see {@link discoverProjects}).
   */
  shortName: string;
  /** Top-level session files only (nested subdirectories are excluded). */
  sessions: SessionInfo[];
  /** Sum of {@link SessionInfo.entryCount} across all sessions. */
  entryTotal: number;
  /** Latest activity: max session mtime, or `undefined` for an empty project. */
  latestMtime: Date | undefined;
}

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
export function discoverProjects(claudeDir: string): ProjectInfo[] {
  const projectsRoot = path.join(claudeDir, "projects");

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
    const sessions = readSessions(projectDir);
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

/** List top-level `*.jsonl` sessions in a project dir, newest first. */
function readSessions(projectDir: string): SessionInfo[] {
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
    let content: string;
    try {
      stat = fs.statSync(filePath);
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      // Unreadable session file: skip it (do not abort the whole scan).
      continue;
    }

    sessions.push({
      file: entry.name,
      path: filePath,
      entryCount: countEntries(content),
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

/** Count non-empty newline-delimited lines. Cheap: no per-line JSON parsing. */
function countEntries(content: string): number {
  if (content.length === 0) return 0;
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
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
