/**
 * sources/kiro/index.ts — the kiro-cli backend as a SessionSource.
 *
 * Binds a kiro config dir (default `~/.kiro`) to the discover/extract/timeline
 * functions. Unlike Claude, kiro classifies human-vs-automation at the SESSION
 * level (K2) — so this source exposes `classify`, wiring the discovery metadata
 * (`.history` presence, parent link) to the extractor's classifier by reading
 * the session's own first prompt.
 */

import fs from "node:fs";
import type { ProjectInfo, SessionInfo, SessionSource } from "../types.js";
import { discoverKiroSessions, type KiroProjectInfo, type KiroSessionInfo } from "./discover.js";
import { classifyKiroLines, extractKiroMessages, kiroTimeline } from "./extract.js";

/** The classification metadata discovery attaches to each session, by path. */
type MetaByPath = Map<string, KiroSessionInfo["meta"]>;

/** Construct the kiro-cli source bound to a config directory. */
export function kiroSource(kiroDir: string): SessionSource {
  // Discovery attaches per-session metadata (.history, parent link) that the
  // session-level classifier needs; cache it by path so `classify` can find it
  // without re-reading the store.
  const metaByPath: MetaByPath = new Map();
  let discoverCache: KiroProjectInfo[] | null = null;

  const discover = (opts?: { countEntries?: boolean }): ProjectInfo[] => {
    const projects = discoverKiroSessions(kiroDir, opts);
    metaByPath.clear();
    for (const project of projects) {
      for (const session of project.sessions) metaByPath.set(session.path, session.meta);
    }
    discoverCache = projects;
    return projects;
  };

  return {
    name: "kiro",
    discover,
    extract: extractKiroMessages,
    timeline: kiroTimeline,
    classify(session: SessionInfo & { project: string }) {
      // Ensure discovery ran at least once so metadata is populated.
      if (discoverCache === null) discover({ countEntries: false });
      const meta = metaByPath.get(session.path);
      if (!meta) return undefined; // unknown session → keep (recall-oriented)
      let lines: string[];
      try {
        lines = fs.readFileSync(session.path, "utf8").split(/\r?\n/);
      } catch {
        return undefined; // unreadable → let the read-error path handle it
      }
      return classifyKiroLines(meta, lines).include ? "interactive" : "automation";
    },
  };
}
