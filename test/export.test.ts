import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type ExportArgs, type ManifestEntry, runExport } from "../src/commands/export.js";

// N5: drive export with the synthetic fixture claude dir, never the real one;
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
      "manifest.json",
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

describe("export — filters", () => {
  it("--min-messages 2 excludes the single-message session", () => {
    const { home, stats } = run({ "min-messages": "2" });
    const files = fs.readdirSync(path.join(home, "exports")).sort();
    expect(files).toEqual(["alpha-a1111111.md", "alpha-b2222222.md", "manifest.json"]);
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
    expect(fs.readdirSync(path.join(home, "exports"))).toEqual(["manifest.json"]);
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
        "readErrors",
        "skippedByFilter",
        "totalMessages",
        "zeroMessageSessions",
      ].sort(),
    );
  });
});
