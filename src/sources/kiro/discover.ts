import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo, SessionInfo } from "../types.js";
import { kiroV3SessionKeys } from "./discover-v3.js";

/**
 * sources/kiro/discover.ts — enumerate kiro-cli sessions.
 *
 * The kiro v2 store is FLAT: every session across every project lives directly
 * under `<kiroDir>/sessions/cli/` as `<uuid>.jsonl` (the append-only event log)
 * with companions `<uuid>.json` (metadata), `<uuid>.history` (readline history
 * — present only where a human typed), `<uuid>.lock`, and `<uuid>/tasks/` (todo
 * sidecar). Project identity is the metadata `cwd` (exact, lossless — no
 * dash-decode heuristics like Claude Code needs). Subagent transcripts live in
 * the same flat dir, so human-vs-automation is a session-level decision made
 * later by the extractor's classify pass, NOT here.
 */

/** Where kiro keeps CLI session transcripts, relative to the kiro config root. */
export const KIRO_SESSIONS_SUBDIR = path.join("sessions", "cli");

/**
 * Per-session metadata we surface to classification/provenance. Only the fields
 * cc-hindsight uses are typed; the companion JSON carries much more.
 */
export interface KiroSessionMeta {
  /** Working directory the session ran in — the project identity. */
  cwd?: string;
  /** Session title (kiro auto-names it; often the first prompt / a marker). */
  title?: string;
  /** Set on spawned children (subagent/rewind). */
  parentSessionId?: string;
  /** kiro's self-reported creation reason (UNRELIABLE — says "subagent" for humans). */
  sessionCreatedReason?: string;
  /** True when a `<uuid>.history` companion exists (a human typed here). */
  hasHistory: boolean;
}

/** A kiro session enriched with the classification metadata discovery gathered. */
export interface KiroSessionInfo extends SessionInfo {
  meta: KiroSessionMeta;
}

/** A kiro "project" — all sessions sharing one `cwd`. */
export interface KiroProjectInfo extends ProjectInfo {
  sessions: KiroSessionInfo[];
}

/** Read + parse `<uuid>.json`; tolerant — missing/corrupt yields an empty meta. */
function readMeta(metaPath: string, hasHistory: boolean): KiroSessionMeta {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    return {
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      parentSessionId:
        typeof parsed.parent_session_id === "string" ? parsed.parent_session_id : undefined,
      sessionCreatedReason:
        typeof parsed.session_created_reason === "string"
          ? parsed.session_created_reason
          : undefined,
      hasHistory,
    };
  } catch {
    // No/corrupt metadata: keep the session (history is still valuable), fall
    // back to an "unknown" project downstream.
    return { hasHistory };
  }
}

/**
 * Count non-empty newline-delimited lines by reading the file in fixed-size
 * chunks (mirrors the Claude discoverer's cheap counter). Unreadable → 0.
 */
export function countFileEntries(filePath: string): number {
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
          if (lineHasContent) count++;
          lineHasContent = false;
        } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
          lineHasContent = true;
        }
      }
    }
    if (lineHasContent) count++;
    return count;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Count orphan `.history` files: readline histories whose `<uuid>.jsonl`
 * transcript no longer exists (5 in the reference census — sessions a human
 * typed in whose transcript was deleted). Surfaced by scan/status so the
 * inventory stays honest about human sessions that can no longer be exported.
 * Missing store → 0 (never throws).
 */
export function countOrphanHistories(kiroDir: string): number {
  const sessionsRoot = path.join(kiroDir, KIRO_SESSIONS_SUBDIR);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const transcripts = new Set<string>();
  const histories: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (dirent.name.endsWith(".jsonl")) transcripts.add(dirent.name.replace(/\.jsonl$/, ""));
    else if (dirent.name.endsWith(".history")) {
      histories.push(dirent.name.replace(/\.history$/, ""));
    }
  }
  // A v3 session's transcript lives in the per-session tree, not the flat store,
  // and its `.history` stem is the v3 dir basename (`sess_<uuid>`) or bare uuid.
  // Such a history is NOT an orphan even though no flat `<stem>.jsonl` exists.
  const v3Keys = kiroV3SessionKeys(kiroDir);
  return histories.filter((stem) => !transcripts.has(stem) && !v3Keys.has(stem)).length;
}

/**
 * Enumerate every kiro session under `<kiroDir>/sessions/cli`, grouped into
 * projects by metadata `cwd`.
 *
 * - Only top-level `<uuid>.jsonl` files are sessions; `.json`/`.history`/`.lock`
 *   companions and `<uuid>/` tasks-sidecar subdirs are ignored for discovery.
 * - A missing sessions dir yields an empty array (never throws) — a machine
 *   that never ran kiro is not an error.
 * - `.history` presence is recorded per session (a human-typed-here signal the
 *   extractor's classify pass uses).
 * - Project short name = `basename(cwd)`, deduplicated deterministically; a
 *   session whose metadata lacks a cwd lands in an "unknown" project.
 *
 * Result is sorted by short name for stable ordering; sessions within a project
 * are newest-first (tie-break on file name), mirroring the Claude discoverer.
 */
export function discoverKiroSessions(
  kiroDir: string,
  opts: { countEntries?: boolean } = {},
): KiroProjectInfo[] {
  return groupKiroSessionsByCwd(collectKiroV2Sessions(kiroDir, opts));
}

/**
 * Collect every flat v2 session under `<kiroDir>/sessions/cli` as an ungrouped
 * {@link KiroSessionInfo} list. A missing store yields []; unreadable session
 * files are skipped, never fatal. The kiro source concatenates these with the v3
 * sessions (discover-v3) and groups the union once via {@link groupKiroSessionsByCwd}.
 */
export function collectKiroV2Sessions(
  kiroDir: string,
  opts: { countEntries?: boolean } = {},
): KiroSessionInfo[] {
  const sessionsRoot = path.join(kiroDir, KIRO_SESSIONS_SUBDIR);
  const countEntriesOpt = opts.countEntries ?? true;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return []; // no flat kiro store on this machine.
  }

  const sessions: KiroSessionInfo[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue; // skip <uuid>/ task-sidecar dirs
    if (!dirent.name.endsWith(".jsonl")) continue; // skip .json/.history/.lock

    const filePath = path.join(sessionsRoot, dirent.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // unreadable session file, skip, do not abort the scan.
    }

    const stem = dirent.name.replace(/\.jsonl$/, "");
    const metaPath = path.join(sessionsRoot, `${stem}.json`);
    const hasHistory = fs.existsSync(path.join(sessionsRoot, `${stem}.history`));
    const meta = readMeta(metaPath, hasHistory);

    sessions.push({
      file: dirent.name,
      path: filePath,
      entryCount: countEntriesOpt ? countFileEntries(filePath) : 0,
      mtime: stat.mtime,
      meta,
    });
  }
  return sessions;
}

/**
 * Group a flat list of kiro sessions (v2 and/or v3) into projects by metadata
 * `cwd`. Sessions within a project are newest-first (tie-break on file name);
 * projects are sorted by short name, and short-name collisions (two different
 * cwds whose basename is identical) are deduped deterministically. Shared by the
 * v2 discoverer and the merged v2+v3 discover in the source, so a cwd that holds
 * both a v2 and a v3 session becomes ONE project, not two.
 */
export function groupKiroSessionsByCwd(sessions: KiroSessionInfo[]): KiroProjectInfo[] {
  const byCwd = new Map<string, KiroSessionInfo[]>();
  for (const session of sessions) {
    const cwd = session.meta.cwd ?? "";
    const list = byCwd.get(cwd);
    if (list) list.push(session);
    else byCwd.set(cwd, [session]);
  }

  const projects: KiroProjectInfo[] = [];
  for (const [cwd, group] of byCwd) {
    // Newest first; tie-break on file name for determinism.
    group.sort((a, b) => {
      const diff = b.mtime.getTime() - a.mtime.getTime();
      return diff !== 0 ? diff : a.file.localeCompare(b.file);
    });
    const decodedPath = cwd || "unknown";
    const shortName = cwd ? path.basename(cwd) || cwd : "unknown";
    const entryTotal = group.reduce((sum, s) => sum + s.entryCount, 0);
    const latestMtime = group.length > 0 ? group[0]?.mtime : undefined;
    projects.push({
      dirName: cwd || "unknown",
      decodedPath,
      shortName,
      sessions: group,
      entryTotal,
      latestMtime,
    });
  }

  // Deterministic ordering by short name, then dedupe short-name collisions
  // (two different cwds whose basename is identical, e.g. two "src" dirs).
  projects.sort(
    (a, b) => a.shortName.localeCompare(b.shortName) || a.dirName.localeCompare(b.dirName),
  );
  const counts = new Map<string, number>();
  for (const project of projects) {
    const base = project.shortName;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    if (seen > 0) project.shortName = `${base}-${seen + 1}`;
  }
  return projects;
}
