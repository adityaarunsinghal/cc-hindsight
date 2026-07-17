import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { countOrphanHistories, discoverKiroSessions } from "../src/sources/kiro/discover.js";
import { kiroSource } from "../src/sources/kiro/index.js";

// Always drive discovery with the synthetic fixture, never the real ~/.kiro.
const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home");
const CLI = path.join(KIRO_HOME, "sessions", "cli");

// git does not preserve mtimes; pin them so "newest first" ordering is stable.
const MTIMES: Record<string, string> = {
  "s-webapp-1.jsonl": "2026-07-13T10:10:00Z",
  "s-webapp-auto.jsonl": "2026-07-13T11:05:00Z",
  "s-webapp-hybrid.jsonl": "2026-07-13T12:05:00Z",
  "s-api-1.jsonl": "2026-07-14T09:20:00Z",
  "s-api-child.jsonl": "2026-07-14T09:06:00Z",
};

beforeAll(() => {
  for (const [file, iso] of Object.entries(MTIMES)) {
    const when = new Date(iso);
    fs.utimesSync(path.join(CLI, file), when, when);
  }
});

describe("discoverKiroSessions — flat store, grouped by cwd", () => {
  it("groups sessions by metadata cwd into projects", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    const names = projects.map((p) => p.shortName).sort();
    expect(names).toEqual(["api", "webapp"]);
  });

  it("pairs each .jsonl with its metadata and records .history presence", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    const webapp = projects.find((p) => p.shortName === "webapp");
    const s1 = webapp?.sessions.find((s) => s.file === "s-webapp-1.jsonl");
    expect(s1?.meta.cwd).toBe("/proj/webapp");
    expect(s1?.meta.hasHistory).toBe(true); // s-webapp-1.history exists
    const auto = webapp?.sessions.find((s) => s.file === "s-webapp-auto.jsonl");
    expect(auto?.meta.hasHistory).toBe(false);
    expect(auto?.meta.title).toBe("[AGENT SYSTEM PROMPT]");
  });

  it("surfaces parent_session_id for spawned children", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    const api = projects.find((p) => p.shortName === "api");
    const child = api?.sessions.find((s) => s.file === "s-api-child.jsonl");
    expect(child?.meta.parentSessionId).toBe("s-api-1");
  });

  it("ignores .json/.history/.lock companions and the tasks-sidecar subdir", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    // Only the 5 .jsonl sessions become SessionInfo — never the lock/sidecar,
    // and never the orphan .history (its transcript is gone).
    const total = projects.reduce((n, p) => n + p.sessions.length, 0);
    expect(total).toBe(5);
    for (const p of projects) {
      for (const s of p.sessions) expect(s.file.endsWith(".jsonl")).toBe(true);
    }
  });

  it("sorts sessions newest-first within a project", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    const api = projects.find((p) => p.shortName === "api");
    // s-api-1 (09:20) is newer than s-api-child (09:06).
    expect(api?.sessions.map((s) => s.file)).toEqual(["s-api-1.jsonl", "s-api-child.jsonl"]);
  });

  it("counts entries when asked (cheap line count)", () => {
    const projects = discoverKiroSessions(KIRO_HOME, { countEntries: true });
    const webapp = projects.find((p) => p.shortName === "webapp");
    const s1 = webapp?.sessions.find((s) => s.file === "s-webapp-1.jsonl");
    expect(s1?.entryCount).toBe(4); // 4 event lines
  });

  it("returns an empty array (never throws) when the store is absent", () => {
    expect(discoverKiroSessions(path.join(KIRO_HOME, "does-not-exist"))).toEqual([]);
  });
});

describe("kiroSource — SessionSource classify (K2)", () => {
  const source = kiroSource(KIRO_HOME);
  const projects = source.discover({ countEntries: false });
  const byFile = new Map(
    projects.flatMap((p) => p.sessions.map((s) => [s.file, { ...s, project: p.shortName }])),
  );

  it("INCLUDES a session with a .history file (human typed here)", () => {
    const s = byFile.get("s-webapp-1.jsonl");
    if (!s) throw new Error("missing fixture");
    expect(source.classify?.(s)).toBe("interactive");
  });

  it("EXCLUDES an [AGENT SYSTEM PROMPT] session with no .history", () => {
    const s = byFile.get("s-webapp-auto.jsonl");
    if (!s) throw new Error("missing fixture");
    expect(source.classify?.(s)).toBe("automation");
  });

  it("EXCLUDES a parent-linked child with no .history", () => {
    const s = byFile.get("s-api-child.jsonl");
    if (!s) throw new Error("missing fixture");
    expect(source.classify?.(s)).toBe("automation");
  });

  it("INCLUDES a plain interactive session with .history", () => {
    const s = byFile.get("s-api-1.jsonl");
    if (!s) throw new Error("missing fixture");
    expect(source.classify?.(s)).toBe("interactive");
  });

  it("INCLUDES a hybrid session (parent-linked AND .history) — K2 step-1 precedence", () => {
    // A rewind/agent-spawned child a human later steered: .history overrides
    // the parent_session_id exclusion AND the automation first prompt.
    const meta = discoverKiroSessions(KIRO_HOME, { countEntries: false })
      .flatMap((p) => p.sessions)
      .find((s) => s.file === "s-webapp-hybrid.jsonl")?.meta;
    expect(meta?.parentSessionId).toBe("s-webapp-1"); // it IS parent-linked
    expect(meta?.hasHistory).toBe(true); // and a human typed here
    const s = byFile.get("s-webapp-hybrid.jsonl");
    if (!s) throw new Error("missing fixture");
    expect(source.classify?.(s)).toBe("interactive");
  });
});

describe("countOrphanHistories — .history with no transcript", () => {
  it("counts the orphan in the fixture store (transcript deleted)", () => {
    // s-deleted-orphan.history exists with no s-deleted-orphan.jsonl.
    expect(countOrphanHistories(KIRO_HOME)).toBe(1);
  });

  it("returns 0 for a missing store (never throws)", () => {
    expect(countOrphanHistories(path.join(KIRO_HOME, "nope"))).toBe(0);
  });
});
