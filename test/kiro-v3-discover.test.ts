import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countOrphanHistories, discoverKiroSessions } from "../src/sources/kiro/discover.js";
import { collectKiroV3Sessions, kiroV3StoreExists } from "../src/sources/kiro/discover-v3.js";
import { kiroSource } from "../src/sources/kiro/index.js";
import { resolveSources } from "../src/sources/registry.js";

// Drive discovery with the synthetic v3 home, never the real ~/.kiro.
const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-v3-home");

const V2_FLAT = "11111111-1111-1111-1111-111111111111.jsonl";
const V2_DUPE = "22222222-2222-2222-2222-222222222222.jsonl";
const V3_SESS3 = "sess_33333333-3333-3333-3333-333333333333.jsonl";
const V3_DUPE = "cli_22222222-2222-2222-2222-222222222222_abcd1234.jsonl";
const V3_SESS4 = "sess_44444444-4444-4444-4444-444444444444.jsonl";
const V3_SESS5 = "sess_55555555-5555-5555-5555-555555555555.jsonl";
const V3_SESS6 = "sess_66666666-6666-6666-6666-666666666666.jsonl";

describe("kiroSource.discover: merged v2 + v3 stores", () => {
  const projects = kiroSource(KIRO_HOME).discover({ countEntries: false });
  const files = (short: string): string[] =>
    (projects.find((p) => p.shortName === short)?.sessions ?? []).map((s) => s.file);

  it("groups both stores by cwd into projects", () => {
    expect(projects.map((p) => p.shortName).sort()).toEqual(["alpha", "beta"]);
  });

  it("merges a v2 and a v3 session that share a cwd into ONE project", () => {
    // alpha holds a v2-only flat session AND a v3-native session.
    expect(files("alpha")).toContain(V2_FLAT);
    expect(files("alpha")).toContain(V3_SESS3);
  });

  it("prefers the v3 copy of a session that exists in both stores (dedup)", () => {
    const alpha = files("alpha");
    expect(alpha).toContain(V3_DUPE); // the v3 migration copy is kept
    expect(alpha).not.toContain(V2_DUPE); // the flat v2 copy is dropped
  });

  it("surfaces every v3-native session under its cwd", () => {
    expect(files("beta").sort()).toEqual([V3_SESS4, V3_SESS5, V3_SESS6].sort());
  });

  it("counts each conversation once (no double-count across stores)", () => {
    const total = projects.reduce((n, p) => n + p.sessions.length, 0);
    expect(total).toBe(6); // alpha: v2only + sess3 + dupe(v3); beta: sess4 + sess5 + sess6
  });

  it("reads the v3 cwd from session.json workspacePaths", () => {
    const sess3 = collectKiroV3Sessions(KIRO_HOME, { countEntries: false }).find(
      (s) => s.file === V3_SESS3,
    );
    expect(sess3?.meta.cwd).toBe("/proj/alpha");
  });

  it("the v2-only discoverer does NOT see v3 sessions (contrast)", () => {
    const v2Only = discoverKiroSessions(KIRO_HOME, { countEntries: false });
    const total = v2Only.reduce((n, p) => n + p.sessions.length, 0);
    expect(total).toBe(2); // only the two flat cli/*.jsonl
  });
});

describe("kiroSource: format-dispatched extract via the merged store", () => {
  const source = kiroSource(KIRO_HOME);
  const byFile = new Map(
    source
      .discover({ countEntries: false })
      .flatMap((p) => p.sessions.map((s) => [s.file, { ...s, project: p.shortName }])),
  );
  const readLines = (file: string): string[] => {
    const s = byFile.get(file);
    if (!s) throw new Error(`missing fixture ${file}`);
    return fs.readFileSync(s.path, "utf8").split(/\r?\n/);
  };

  it("extracts a v3 session's human text", () => {
    expect(source.extract(readLines(V3_SESS3)).messages.map((m) => m.text)).toEqual([
      "hello from sess3",
    ]);
  });

  it("extracts a v2 flat session's human text through the same source", () => {
    expect(source.extract(readLines(V2_FLAT)).messages.map((m) => m.text)).toEqual([
      "v2 only message",
    ]);
  });
});

describe("kiroSource.classify: v3 sessions via the merged store", () => {
  const source = kiroSource(KIRO_HOME);
  const byFile = new Map(
    source
      .discover({ countEntries: false })
      .flatMap((p) => p.sessions.map((s) => [s.file, { ...s, project: p.shortName }])),
  );
  const verdict = (file: string) => {
    const s = byFile.get(file);
    if (!s) throw new Error(`missing fixture ${file}`);
    return source.classify?.(s);
  };

  it("INCLUDES a v3 session with a .history companion", () => {
    expect(verdict(V3_SESS3)).toBe("interactive");
  });
  it("INCLUDES a plain v3 session with no .history (recall default)", () => {
    expect(verdict(V3_SESS4)).toBe("interactive");
  });
  it("EXCLUDES a v3 cc-hindsight distill session", () => {
    expect(verdict(V3_SESS5)).toBe("automation");
  });
  it("INCLUDES a v3 fork (parentSessionId set, no .history)", () => {
    expect(verdict(V3_SESS6)).toBe("interactive");
  });
  it("still classifies a v2 flat session through the same source", () => {
    expect(verdict(V2_FLAT)).toBe("interactive"); // no history, plain prompt, recall default
  });
});

describe("countOrphanHistories: v3-aware", () => {
  it("does NOT mis-flag a v3 session's .history as an orphan", () => {
    // cli/ holds: sess_33333333.history (v3 session exists -> not orphan),
    // 22222222.history (flat 22222222.jsonl exists -> not orphan),
    // deadbeef.history (no transcript anywhere -> the only orphan).
    expect(countOrphanHistories(KIRO_HOME)).toBe(1);
  });
});

describe("registry: kiro store detected when only the v3 store exists", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cch-v3only-"));
    const sdir = path.join(tmp, "sessions", "wshash", "sess_77777777-7777-7777-7777-777777777777");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, "messages.jsonl"),
      `${JSON.stringify({ id: "1", timestamp: "2026-08-03T00:00:00.000Z", payload: { type: "user", content: "hi" } })}\n`,
    );
    fs.writeFileSync(
      path.join(sdir, "session.json"),
      JSON.stringify({ workspacePaths: ["/proj/only-v3"], title: "v3 only" }),
    );
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("kiroV3StoreExists is true and `auto` resolves a kiro source with no flat store", () => {
    expect(kiroV3StoreExists(tmp)).toBe(true);
    const sources = resolveSources("auto", {
      claudeDir: path.join(tmp, "no-claude"),
      kiroDir: tmp,
    });
    expect(sources.map((s) => s.name)).toContain("kiro");
  });

  it("kiroV3StoreExists is false for a missing store (never throws)", () => {
    expect(kiroV3StoreExists(path.join(KIRO_HOME, "does-not-exist"))).toBe(false);
  });
});
