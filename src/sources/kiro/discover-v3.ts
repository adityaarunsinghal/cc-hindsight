import fs from "node:fs";
import path from "node:path";
import { countFileEntries, type KiroSessionInfo, type KiroSessionMeta } from "./discover.js";

/**
 * sources/kiro/discover-v3.ts: enumerate kiro-cli v3 ("Sol" harness) sessions.
 *
 * The v3 store is a per-session tree (contrast the flat v2 store in discover.ts):
 *
 *   <kiroDir>/sessions/<workspaceHash>/<sessionDir>/
 *       messages.jsonl   the {id, timestamp, payload} event log (parsed by extract-v3)
 *       session.json     metadata: id, title, agentMode, workspacePaths, status, parentSessionId
 *       snapshots/       filesystem checkpoints (ignored)
 *       sub-executions/  subagent transcripts (same line format; never surfaced as sessions)
 *
 * <sessionDir> is `sess_<uuid>` (v3-native) or `cli_<uuid>_<suffix>` (a session that
 * also has a flat v2 `cli/<uuid>.jsonl`; the source dedupes those, preferring v3).
 * Project identity is `session.json.workspacePaths[0]` (fallback `rootPaths[0]`),
 * exact like the v2 cwd. Only `messages.jsonl` at a session-dir root marks a session,
 * so snapshots and sub-executions are skipped without a deep walk.
 *
 * A session's human `.history` companion is written under the flat store, as
 * `cli/sess_<uuid>.history` (sess dirs) or `cli/<uuid>.history` (cli dirs). This
 * module surfaces both the presence signal (per session) and the key set
 * ({@link kiroV3SessionKeys}) so countOrphanHistories does not mis-flag those as orphans.
 */

const SESSIONS_DIR = "sessions";
/** The flat v2 store lives at sessions/cli; it is not a v3 workspace-hash dir. */
const V2_FLAT_SUBDIR = "cli";
const MESSAGES_FILE = "messages.jsonl";
const SESSION_META_FILE = "session.json";

/** Extract the bare session uuid from a v3 dir basename (`sess_<uuid>` / `cli_<uuid>_<suffix>`). */
export function coreUuid(stem: string): string {
  const m = /(?:sess|cli)_([0-9a-fA-F-]{36})/.exec(stem);
  return m?.[1] ?? stem;
}

/** Stems of `.history` files under the flat store, used to detect a v3 session's human signal. */
function historyStems(kiroDir: string): Set<string> {
  const dir = path.join(kiroDir, SESSIONS_DIR, V2_FLAT_SUBDIR);
  try {
    const stems = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".history"))
      .map((f) => f.slice(0, -".history".length));
    return new Set(stems);
  } catch {
    return new Set();
  }
}

/** Read + parse a v3 `session.json`; tolerant, missing/corrupt yields an empty meta. */
function readV3Meta(sessionDir: string, hasHistory: boolean): KiroSessionMeta {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(sessionDir, SESSION_META_FILE), "utf8"),
    ) as Record<string, unknown>;
    const paths = [parsed.workspacePaths, parsed.rootPaths].find(Array.isArray) as
      | unknown[]
      | undefined;
    const cwd = typeof paths?.[0] === "string" ? (paths[0] as string) : undefined;
    return {
      cwd,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      // v3 spells these camelCase (v2 used parent_session_id / session_created_reason).
      parentSessionId:
        typeof parsed.parentSessionId === "string" ? parsed.parentSessionId : undefined,
      sessionCreatedReason:
        typeof parsed.createdReason === "string" ? parsed.createdReason : undefined,
      hasHistory,
    };
  } catch {
    return { hasHistory };
  }
}

/**
 * Collect every v3 session as a flat {@link KiroSessionInfo} list (ungrouped; the
 * source groups v2+v3 together by cwd). `file` is `<sessionDir>.jsonl` so the
 * exporter's `file.replace(/\.jsonl$/, "")` yields a unique, meaningful session id.
 * A missing store yields []; unreadable session dirs are skipped, never fatal.
 */
export function collectKiroV3Sessions(
  kiroDir: string,
  opts: { countEntries?: boolean } = {},
): KiroSessionInfo[] {
  const root = path.join(kiroDir, SESSIONS_DIR);
  let hashDirs: fs.Dirent[];
  try {
    hashDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const countEntries = opts.countEntries ?? true;
  const stems = historyStems(kiroDir);
  const sessions: KiroSessionInfo[] = [];

  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory() || hashDir.name === V2_FLAT_SUBDIR) continue;
    const hashPath = path.join(root, hashDir.name);
    let subdirs: fs.Dirent[];
    try {
      subdirs = fs.readdirSync(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of subdirs) {
      if (!sd.isDirectory()) continue;
      const messagesPath = path.join(hashPath, sd.name, MESSAGES_FILE);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(messagesPath);
      } catch {
        continue; // no messages.jsonl → not a session dir (snapshots, etc.)
      }
      if (!stat.isFile()) continue;
      const hasHistory = stems.has(sd.name) || stems.has(coreUuid(sd.name));
      sessions.push({
        file: `${sd.name}.jsonl`,
        path: messagesPath,
        entryCount: countEntries ? countFileEntries(messagesPath) : 0,
        mtime: stat.mtime,
        meta: readV3Meta(path.join(hashPath, sd.name), hasHistory),
      });
    }
  }
  return sessions;
}

/**
 * The identifiers a v3 session is known by: its dir basename AND its bare uuid.
 * Used to (a) dedupe a v2 flat session whose uuid also has a v3 dir, and (b) keep
 * countOrphanHistories from mis-flagging `cli/sess_<uuid>.history` as an orphan.
 */
export function kiroV3SessionKeys(kiroDir: string): Set<string> {
  const keys = new Set<string>();
  for (const s of collectKiroV3Sessions(kiroDir, { countEntries: false })) {
    const stem = s.file.replace(/\.jsonl$/, "");
    keys.add(stem);
    keys.add(coreUuid(stem));
  }
  return keys;
}

/** True when at least one v3 session exists under `<kiroDir>/sessions`. */
export function kiroV3StoreExists(kiroDir: string): boolean {
  return collectKiroV3Sessions(kiroDir, { countEntries: false }).length > 0;
}
