/**
 * sources/kiro/index.ts: the kiro-cli backend as a SessionSource.
 *
 * Binds a kiro config dir (default `~/.kiro`) to the discover/extract/timeline
 * functions, spanning BOTH on-disk stores: the flat v2 store
 * (`sessions/cli/<uuid>.jsonl`, `{version,kind,data}`) and the v3 per-session
 * store (`sessions/<hash>/<sessionDir>/messages.jsonl`, `{id,timestamp,payload}`).
 * Discovery merges the two and prefers v3 when a session exists in both (the
 * `cli_<uuid>` migration case); extract/timeline/classify sniff each session's
 * format from its lines and dispatch. Kiro classifies human-vs-automation at the
 * SESSION level, so this source exposes `classify`, wiring discovery metadata
 * (`.history` presence, parent link) to the per-format classifier.
 */

import fs from "node:fs";
import type {
  ExtractResult,
  ProjectInfo,
  SessionInfo,
  SessionSource,
  TimelineEvent,
} from "../types.js";
import { collectKiroV2Sessions, groupKiroSessionsByCwd, type KiroSessionInfo } from "./discover.js";
import { collectKiroV3Sessions, coreUuid } from "./discover-v3.js";
import { classifyKiroLines, extractKiroMessages, kiroTimeline } from "./extract.js";
import {
  classifyKiroV3Lines,
  detectKiroFormat,
  extractKiroV3Messages,
  kiroV3Timeline,
} from "./extract-v3.js";

/** The classification metadata discovery attaches to each session, by path. */
type MetaByPath = Map<string, KiroSessionInfo["meta"]>;

/** Construct the kiro-cli source bound to a config directory. */
export function kiroSource(kiroDir: string): SessionSource {
  // Discovery attaches per-session metadata (.history, parent link) that the
  // session-level classifier needs; cache it by path so `classify` can find it
  // without re-reading the store.
  const metaByPath: MetaByPath = new Map();
  let discovered = false;

  const discover = (opts?: { countEntries?: boolean }): ProjectInfo[] => {
    // A session migrated into the v3 store keeps its uuid AND a flat v2 file; keep
    // only the v3 copy (newer, more complete) so it is not counted or exported twice.
    const v3 = collectKiroV3Sessions(kiroDir, opts);
    const v3Ids = new Set(v3.map((s) => coreUuid(s.file.replace(/\.jsonl$/, ""))));
    const v2 = collectKiroV2Sessions(kiroDir, opts).filter(
      (s) => !v3Ids.has(s.file.replace(/\.jsonl$/, "")),
    );
    const projects = groupKiroSessionsByCwd([...v2, ...v3]);
    metaByPath.clear();
    for (const project of projects) {
      for (const session of project.sessions) metaByPath.set(session.path, session.meta);
    }
    discovered = true;
    return projects;
  };

  return {
    name: "kiro",
    discover,
    extract(lines: string[]): ExtractResult {
      return detectKiroFormat(lines) === "v3"
        ? extractKiroV3Messages(lines)
        : extractKiroMessages(lines);
    },
    timeline(lines: string[]): TimelineEvent[] {
      return detectKiroFormat(lines) === "v3" ? kiroV3Timeline(lines) : kiroTimeline(lines);
    },
    classify(session: SessionInfo & { project: string }) {
      // Ensure discovery ran at least once so metadata is populated.
      if (!discovered) discover({ countEntries: false });
      const meta = metaByPath.get(session.path);
      if (!meta) return undefined; // unknown session → keep (recall-oriented)
      let lines: string[];
      try {
        lines = fs.readFileSync(session.path, "utf8").split(/\r?\n/);
      } catch {
        return undefined; // unreadable → let the read-error path handle it
      }
      const verdict =
        detectKiroFormat(lines) === "v3"
          ? classifyKiroV3Lines(meta, lines)
          : classifyKiroLines(meta, lines);
      return verdict.include ? "interactive" : "automation";
    },
  };
}
