import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type ExportArgs, type ManifestEntry, runExport } from "../src/commands/export.js";

// Drive export with the synthetic fixture claude dir, never the real one;
// every home directory is a fresh mkdtemp, never a real ~/.cc-hindsight.
const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "export-home");
const ALPHA_DIR = path.join(CLAUDE_HOME, "projects", "-Users-dev-alpha");

const tmpHomes: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hindsight-export-"));
  tmpHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of tmpHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A Writable that accumulates output, VT-stripped on read. */
function makeSink(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { sink, text: () => stripVTControlCharacters(chunks.join("")) };
}

/** Run export against the fixture into a fresh tmp home. */
function run(extra: Partial<ExportArgs> = {}): {
  home: string;
  stats: ReturnType<typeof runExport>;
  out: string;
} {
  const home = freshHome();
  const { sink, text } = makeSink();
  const stats = runExport({ home, "claude-dir": CLAUDE_HOME, output: sink, ...extra });
  return { home, stats, out: text() };
}

function readManifest(home: string): ManifestEntry[] {
  const raw = fs.readFileSync(path.join(home, "exports", "manifest.json"), "utf8");
  return JSON.parse(raw) as ManifestEntry[];
}

describe("export — default run", () => {
  it("writes one markdown per exported session plus a manifest", () => {
    const { home, stats } = run();
    const files = fs.readdirSync(path.join(home, "exports")).sort();
    expect(files).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "alpha-c3333333.md",
      "anaphora.json",
      "manifest.json",
      "outcomes.json",
    ]);
    expect(stats.files).toEqual(["alpha-a1111111.md", "alpha-b2222222.md", "alpha-c3333333.md"]);
    expect(stats.exportedSessions).toBe(3);
    expect(stats.totalMessages).toBe(7);
    expect(stats.duplicatesDropped).toBe(3);
  });

  it("skips the zero-human-message session (R9) and counts it", () => {
    const { home, stats } = run();
    expect(fs.existsSync(path.join(home, "exports", "beta-d4444444.md"))).toBe(false);
    expect(stats.zeroMessageSessions).toBe(1);
    expect(readManifest(home).some((e) => e.project === "beta")).toBe(false);
  });

  it("renders the forked export with fork copies removed, re-send kept, exact bytes", () => {
    const { home } = run();
    const source = path.join(ALPHA_DIR, "b2222222-2222-2222-2222-222222222222.jsonl");
    const expected =
      `<!-- source: ${source}\n     messages: 3 -->\n` +
      "\n### 2026-03-01T11:00:00.000Z\n\nAlso add a release workflow.\n" +
      "\n### 2026-03-01T11:01:00.000Z\n\nPin all action versions.\n" +
      "\n### 2026-03-01T11:02:00.000Z\n\nUse TypeScript and vitest.\n";
    const actual = fs.readFileSync(path.join(home, "exports", "alpha-b2222222.md"), "utf8");
    expect(actual).toBe(expected);
  });

  it("produces a well-formed, deterministically sorted manifest", () => {
    const { home } = run();
    const manifest = readManifest(home);
    expect(manifest.map((e) => e.export)).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "alpha-c3333333.md",
    ]);

    const forked = manifest.find((e) => e.export === "alpha-b2222222.md");
    expect(forked).toEqual({
      export: "alpha-b2222222.md",
      source: path.join(ALPHA_DIR, "b2222222-2222-2222-2222-222222222222.jsonl"),
      project: "alpha",
      sessionId: "b2222222-2222-2222-2222-222222222222",
      messages: 3,
      first_ts: "2026-03-01T11:00:00.000Z",
      last_ts: "2026-03-01T11:02:00.000Z",
    });

    const original = manifest.find((e) => e.export === "alpha-a1111111.md");
    expect(original?.messages).toBe(3);
    expect(original?.first_ts).toBe("2026-03-01T10:00:00.000Z");
    expect(original?.last_ts).toBe("2026-03-01T10:02:00.000Z");
  });

  it("prints the summary line and the distill funnel hint", () => {
    const { out } = run();
    expect(out).toContain("exported 3 sessions (7 messages, 3 duplicates dropped)");
    expect(out).toContain("→ next: cc-hindsight distill");
    expect(out).toContain("1 session(s) had no human messages");
    // Anaphora/outcome summary line (export-home has no plans/questions).
    expect(out).toContain("short turns attached (0 had a pending plan/question)");
    expect(out).toContain("outcome evidence captured for 3 sessions");
  });
});

describe("export — idempotency", () => {
  it("re-running against the same input produces byte-identical files", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({ home, "claude-dir": CLAUDE_HOME, output: sink });

    const dir = path.join(home, "exports");
    const first = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) first.set(f, fs.readFileSync(path.join(dir, f)));

    // Run a second time into the same home.
    const { sink: sink2 } = makeSink();
    runExport({ home, "claude-dir": CLAUDE_HOME, output: sink2 });

    const second = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) second.set(f, fs.readFileSync(path.join(dir, f)));

    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [name, buf] of first) {
      expect(second.get(name)?.equals(buf)).toBe(true);
    }
  });
});

describe("export — hygiene & permissions", () => {
  it("prunes a stale export whose session vanished, on an unfiltered run", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({ home, "claude-dir": CLAUDE_HOME, output: sink });
    const stale = path.join(home, "exports", "ghost-deadbeef.md");
    fs.writeFileSync(stale, "# stale");

    const { sink: sink2 } = makeSink();
    const stats = runExport({ home, "claude-dir": CLAUDE_HOME, output: sink2 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(stats.prunedExports).toBe(1);
  });

  it("does NOT prune under a --project filter (subset run)", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({ home, "claude-dir": CLAUDE_HOME, output: sink });
    const other = path.join(home, "exports", "other-project.md");
    fs.writeFileSync(other, "# from another scope");

    const { sink: sink2 } = makeSink();
    const stats = runExport({ home, "claude-dir": CLAUDE_HOME, project: "alpha", output: sink2 });
    expect(fs.existsSync(other)).toBe(true);
    expect(stats.prunedExports).toBe(0);
  });

  it.skipIf(process.platform === "win32")("writes owner-only exports (0600) in a 0700 dir", () => {
    const { home } = run();
    expect(fs.statSync(path.join(home, "exports")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, "exports", "alpha-a1111111.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "exports", "manifest.json")).mode & 0o777).toBe(0o600);
  });
});

describe("export — filters", () => {
  it("--min-messages 2 excludes the single-message session", () => {
    const { home, stats } = run({ "min-messages": "2" });
    const files = fs.readdirSync(path.join(home, "exports")).sort();
    expect(files).toEqual([
      "alpha-a1111111.md",
      "alpha-b2222222.md",
      "anaphora.json",
      "manifest.json",
      "outcomes.json",
    ]);
    expect(stats.exportedSessions).toBe(2);
    expect(stats.belowMinMessages).toBe(1);
    expect(stats.totalMessages).toBe(6);
  });

  it("--project alpha exports only alpha and reports the filtered project", () => {
    const { home, stats } = run({ project: "alpha" });
    expect(stats.exportedSessions).toBe(3);
    expect(stats.skippedByFilter).toBe(1); // beta's one session
    expect(stats.zeroMessageSessions).toBe(0); // beta was never read
    expect(readManifest(home).every((e) => e.project === "alpha")).toBe(true);
  });

  it("--project beta yields no exports (its only session has no human messages)", () => {
    const { home, stats } = run({ project: "beta" });
    expect(stats.exportedSessions).toBe(0);
    expect(stats.zeroMessageSessions).toBe(1);
    expect(stats.skippedByFilter).toBe(3); // alpha's three sessions
    expect(readManifest(home)).toEqual([]);
    expect(fs.readdirSync(path.join(home, "exports")).sort()).toEqual([
      "anaphora.json",
      "manifest.json",
      "outcomes.json",
    ]);
  });
});

describe("export — verbose observability", () => {
  it("reports dedupe drops and every extractor drop under --verbose", () => {
    const { out } = run({ verbose: true });
    // Fork copies dropped for the forked session (s2 copied s1's 3 messages).
    expect(out).toContain("3 fork-copy dropped");
    // The <ide_opened_file> machine block from the original session.
    expect(out).toContain("R6: machine block (leading <)");
    // Zero-message session flagged, not exported.
    expect(out).toContain("skipped (no messages)");
  });

  it("returns a complete stats object shape", () => {
    const { stats } = run({ verbose: true });
    expect(Object.keys(stats).sort()).toEqual(
      [
        "badLines",
        "belowMinMessages",
        "duplicatesDropped",
        "exportedSessions",
        "exportsDir",
        "files",
        "outcomeSessions",
        "prunedExports",
        "readErrors",
        "shortTurns",
        "shortTurnsWithDecision",
        "skippedByFilter",
        "totalMessages",
        "zeroMessageSessions",
      ].sort(),
    );
  });
});

// ---- anaphora.json + outcomes.json integration (anaphora-home) ------

const ANAPHORA_HOME = path.join(import.meta.dirname, "fixtures", "anaphora-home");

/** Run export against the anaphora fixture into a fresh tmp home. */
function runAnaphora(extra: Partial<ExportArgs> = {}): {
  home: string;
  stats: ReturnType<typeof runExport>;
  out: string;
} {
  const home = freshHome();
  const { sink, text } = makeSink();
  const stats = runExport({ home, "claude-dir": ANAPHORA_HOME, output: sink, ...extra });
  return { home, stats, out: text() };
}

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary parsed JSON in tests.
function readJson(home: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, "exports", name), "utf8"));
}

/** Parse a rendered export markdown into ordered { timestamp, text } blocks. */
function parseBlocks(markdown: string): { timestamp: string; text: string }[] {
  return markdown
    .split("\n### ")
    .slice(1)
    .map((part) => {
      const nl = part.indexOf("\n");
      return {
        timestamp: part.slice(0, nl),
        text: part
          .slice(nl + 1)
          .replace(/^\n/, "")
          .replace(/\n$/, ""),
      };
    });
}

describe("export — anaphora + outcome artifacts", () => {
  it("writes anaphora.json and outcomes.json with the expected counts", () => {
    const { home, stats } = runAnaphora();
    expect(stats.exportedSessions).toBe(2);
    expect(stats.shortTurns).toBe(8);
    expect(stats.shortTurnsWithDecision).toBe(2);
    expect(stats.outcomeSessions).toBe(2);
    expect(fs.existsSync(path.join(home, "exports", "anaphora.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "exports", "outcomes.json"))).toBe(true);
  });

  it("surfaces the approved plan, the answered question, and skips the long turn", () => {
    const { home } = runAnaphora();
    const anaphora = readJson(home, "anaphora.json");

    const s1 = anaphora["work-aaaa1111.md"];
    const yes = s1.find((r: { human_text: string }) => r.human_text === "yes");
    expect(yes.decision_kind).toBe("plan");
    expect(yes.decision_text).toContain("## Plan");
    expect(yes.antecedent).toContain("proposed plan");

    // Long (>15-word) human turn gets NO record.
    expect(
      s1.some((r: { human_text: string }) => r.human_text.startsWith("This is a deliberately")),
    ).toBe(false);

    const s2 = anaphora["work-bbbb2222.md"];
    const opt = s2.find((r: { human_text: string }) => r.human_text === "option 2");
    expect(opt.decision_kind).toBe("question");
    expect(opt.decision_text).toContain("Which database?");
    expect(opt.decision_text).toContain("MySQL");
  });

  it("bounds the antecedent to the 1600-char TAIL and excludes sidechain turns", () => {
    const { home } = runAnaphora();
    const s1 = readJson(home, "anaphora.json")["work-aaaa1111.md"];

    // Antecedent-only turn after a >1600-char assistant essay.
    const looksGood = s1.find(
      (r: { human_text: string }) => r.human_text === "Looks good, proceed.",
    );
    expect(looksGood.antecedent.length).toBe(1600);
    expect(looksGood.antecedent.endsWith("ESSAY_END")).toBe(true);
    expect(looksGood.antecedent.includes("ESSAY_START")).toBe(false);
    expect(looksGood.decision_kind).toBeNull();

    // The sidechain assistant turn immediately before "ok" must NOT be its antecedent.
    const ok = s1.find((r: { human_text: string }) => r.human_text === "ok");
    expect(ok.antecedent).not.toContain("SIDECHAIN");
    expect(ok.antecedent.endsWith("ESSAY_END")).toBe(true);
  });

  it("captures bounded, labeled outcome evidence per session", () => {
    const { home } = runAnaphora();
    const outcomes = readJson(home, "outcomes.json");

    expect(outcomes._note).toContain("machine-authored");

    const o1 = outcomes["work-aaaa1111.md"];
    expect(o1.final_human_turns).toHaveLength(3);
    expect(o1.final_human_turns[0]).toBe("ok");
    expect(o1.final_human_turns[2]).toBe("done for now");
    expect(o1.final_assistant_tail.length).toBeLessThanOrEqual(1600);
    expect(o1.final_assistant_tail.endsWith("ESSAY_END")).toBe(true);

    const o2 = outcomes["work-bbbb2222.md"];
    expect(o2.final_human_turns).toEqual([
      "Set up the database layer.",
      "option 2",
      "great thanks",
    ]);
    expect(o2.final_assistant_tail).toBe("Using MySQL then.");
  });

  it("aligns every anaphora index with the actual rendered export markdown", () => {
    const { home } = runAnaphora();
    const anaphora = readJson(home, "anaphora.json");
    for (const file of ["work-aaaa1111.md", "work-bbbb2222.md"]) {
      const markdown = fs.readFileSync(path.join(home, "exports", file), "utf8");
      const blocks = parseBlocks(markdown);
      for (const record of anaphora[file]) {
        expect(blocks[record.index]?.timestamp).toBe(record.timestamp);
        expect(blocks[record.index]?.text).toBe(record.human_text);
      }
    }
  });

  it("re-running is byte-identical for the JSON artifacts (idempotent)", () => {
    const home = freshHome();
    const { sink } = makeSink();
    runExport({ home, "claude-dir": ANAPHORA_HOME, output: sink });
    const dir = path.join(home, "exports");
    const first = new Map<string, Buffer>();
    for (const f of fs.readdirSync(dir)) first.set(f, fs.readFileSync(path.join(dir, f)));

    const { sink: sink2 } = makeSink();
    runExport({ home, "claude-dir": ANAPHORA_HOME, output: sink2 });
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f)).equals(first.get(f) as Buffer)).toBe(true);
    }
  });

  it("prints the attachment summary line and per-session attachments under --verbose", () => {
    const { out } = runAnaphora({ verbose: true });
    expect(out).toContain(
      "8 short turns attached (2 had a pending plan/question); outcome evidence captured for 2 sessions",
    );
    expect(out).toContain("short turn(s) attached");
    expect(out).toContain("+plan");
    expect(out).toContain("+question");
  });
});
