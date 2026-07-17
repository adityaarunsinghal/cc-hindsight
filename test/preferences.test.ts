import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import { runPreferences } from "../src/commands/preferences.js";
import type { LibraryEntry } from "../src/core/library.js";
import {
  aggregatePreferences,
  normalizeKey,
  renderClaudeMdBlock,
  renderPreferencesBlock,
} from "../src/core/preferences.js";
import type { RunnerFn } from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-prefs-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function entry(
  slug: string,
  prefs: { text: string; evidence: string }[],
  authoredAt = "2026-07-01T00:00:00.000Z",
): LibraryEntry {
  return {
    slug,
    dir: `/x/${slug}`,
    oneshotPath: `/x/${slug}/${slug}.oneshot.md`,
    sources: {
      slug,
      title: slug,
      members: ["a.md"],
      sessionIds: ["s"],
      preferences: prefs,
      outcome_summary: "1 completed",
      domains: ["testing"],
      confidence: "high",
      authored_at: authoredAt,
      model: null,
      prompt_version: 1,
      tool_version: "0.1.0",
      generation: "g1",
    },
  };
}

function writeLibraryEntry(home: string, e: LibraryEntry): void {
  const dir = path.join(home, "library", e.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify(e.sources));
}

function capture(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { out, text: () => chunks.join("") };
}

function inputWith(line: string): Readable {
  const pt = new PassThrough();
  pt.end(line);
  return pt;
}

/** Recording fake clipboard: captures the text and reports a fixed tool. */
function fakeClipboard(): {
  copy: (text: string) => Promise<{ ok: true; tool: string }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    copy: async (text: string) => {
      calls.push(text);
      return { ok: true, tool: "pbcopy" };
    },
  };
}

// --- aggregation -------------------------------------------------------------

describe("normalizeKey", () => {
  it("folds case, whitespace, and punctuation", () => {
    expect(normalizeKey("Diagnose before acting.")).toBe("diagnose before acting");
    expect(normalizeKey("  diagnose   BEFORE acting ")).toBe("diagnose before acting");
    expect(normalizeKey("Don't guess!")).toBe("dont guess");
  });
});

describe("aggregatePreferences", () => {
  it("dedupes near-identical strings and ranks by frequency then recency", () => {
    const entries = [
      entry("task-one-here", [
        { text: "Diagnose before acting.", evidence: "e1" },
        { text: "pin versions", evidence: "e2" },
      ]),
      entry(
        "task-two-here",
        [{ text: "diagnose before acting", evidence: "e3" }],
        "2026-07-05T00:00:00.000Z",
      ),
      entry("task-three-here", [{ text: "Be terse", evidence: "e4" }], "2026-07-09T00:00:00.000Z"),
    ];
    const prefs = aggregatePreferences(entries);
    expect(prefs).toHaveLength(3);
    // frequency first: the duplicated one wins
    expect(prefs[0]?.count).toBe(2);
    expect(prefs[0]?.text).toBe("diagnose before acting"); // newest phrasing
    expect(prefs[0]?.occurrences.map((o) => o.slug)).toEqual(["task-one-here", "task-two-here"]);
    // recency tiebreak between the two count-1 items:
    expect(prefs[1]?.text).toBe("Be terse");
    expect(prefs[2]?.text).toBe("pin versions");
  });

  it("counts a preference once per task even if restated", () => {
    const prefs = aggregatePreferences([
      entry("task-one-here", [
        { text: "be terse", evidence: "a" },
        { text: "Be terse.", evidence: "b" },
      ]),
    ]);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.count).toBe(1);
  });
});

describe("renderClaudeMdBlock", () => {
  it("groups the paste-ready block by occurrence count, most-stated first", () => {
    const entries = [
      entry("t-one-a", [{ text: "diagnose before acting", evidence: "e" }]),
      entry("t-two-b", [{ text: "diagnose before acting", evidence: "e" }]),
      entry("t-three-c", [{ text: "pin versions", evidence: "e" }]),
    ];
    const block = renderClaudeMdBlock(
      aggregatePreferences(entries),
      3,
      new Date("2026-07-13T00:00:00Z"),
    );
    expect(block.split("\n")).toEqual([
      "<!-- cc-hindsight preferences · generated 2026-07-13 -->",
      "## Working preferences",
      "",
      "<!-- stated in 2 of 3 tasks -->",
      "- diagnose before acting",
      "",
      "<!-- stated in 1 of 3 tasks -->",
      "- pin versions",
    ]);
  });

  it("renders consolidated items (no occurrences) as a flat list without headers", () => {
    const merged = [
      { text: "be terse", count: 3, occurrences: [], lastAuthoredAt: "" },
      { text: "pin versions", count: 1, occurrences: [], lastAuthoredAt: "" },
    ];
    const block = renderClaudeMdBlock(merged, 5, new Date("2026-07-13T00:00:00Z"));
    expect(block).toContain("- be terse");
    expect(block).not.toContain("stated in");
  });
});

describe("renderPreferencesBlock — targets", () => {
  const prefs = [
    {
      text: "diagnose before acting",
      count: 1,
      occurrences: [{ slug: "t", evidence: "e" }],
      lastAuthoredAt: "",
    },
  ];
  const NOW = new Date("2026-07-13T00:00:00Z");

  it("claude target is byte-identical to renderClaudeMdBlock (deprecated wrapper)", () => {
    expect(renderPreferencesBlock(prefs, 1, "claude", NOW)).toBe(
      renderClaudeMdBlock(prefs, 1, NOW),
    );
  });

  it("kiro target names the steering file in the provenance comment; body unchanged", () => {
    const block = renderPreferencesBlock(prefs, 1, "kiro", NOW);
    expect(block).toContain("~/.kiro/steering/hindsight-preferences.md");
    expect(block).toContain("## Working preferences");
    expect(block).toContain("- diagnose before acting");
    // Same body as claude — only the leading comment differs.
    const claudeBody = renderClaudeMdBlock(prefs, 1, NOW).split("\n").slice(1).join("\n");
    expect(block.split("\n").slice(1).join("\n")).toBe(claudeBody);
  });

  it("agents target points at AGENTS.md; body unchanged", () => {
    const block = renderPreferencesBlock(prefs, 1, "agents", NOW);
    expect(block).toContain("add to AGENTS.md");
    const claudeBody = renderClaudeMdBlock(prefs, 1, NOW).split("\n").slice(1).join("\n");
    expect(block.split("\n").slice(1).join("\n")).toBe(claudeBody);
  });
});

// --- command -------------------------------------------------------------------

describe("runPreferences", () => {
  it("exits 1 with a hint when the library is empty", async () => {
    const cap = capture();
    const code = await runPreferences({ home: tmpHome() }, { output: cap.out });
    expect(code).toBe(1);
    expect(cap.text()).toContain("library is empty");
    expect(cap.text()).toContain("cc-hindsight distill");
  });

  it("prints the deterministic block without any claude involvement", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]));
    const cap = capture();
    const runner: RunnerFn = (async () => {
      throw new Error("must not be called");
    }) as RunnerFn;
    const code = await runPreferences({ home }, { output: cap.out, runner });
    expect(code).toBe(0);
    expect(cap.text()).toContain("1 preference(s) across 2 task(s)");
    expect(cap.text()).toContain("- be terse");
    expect(cap.text()).toContain("stated in 2 of 2 tasks");
  });

  it("--target kiro renders the steering-file block and footer", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const code = await runPreferences({ home, target: "kiro" }, { output: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("~/.kiro/steering/hindsight-preferences.md");
    expect(cap.text()).toContain("- be terse");
  });

  it("--target agents renders an AGENTS.md block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const code = await runPreferences({ home, target: "agents" }, { output: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("AGENTS.md");
  });

  it("--consolidate declined exits 2 and never invokes", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return { preferences: [] };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, consolidate: true },
      { output: cap.out, input: inputWith("n\n"), runner },
    );
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(cap.text()).toContain("declined");
  });

  it("--consolidate with --yes runs one call and prints the merged block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "keep answers terse", evidence: "e" }]));
    const cap = capture();
    let prompt = "";
    let model: string | undefined;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      model = opts.model;
      return { preferences: [{ text: "be terse", merged_from: 2 }] };
    }) as RunnerFn;
    const code = await runPreferences(
      { home, consolidate: true, yes: true, model: "sonnet" },
      { output: cap.out, runner },
    );
    expect(code).toBe(0);
    expect(model).toBe("sonnet"); // --model must reach the claude call
    expect(prompt).toContain("Merge semantic duplicates");
    expect(prompt).toContain("- be terse (stated in 1 task(s))");
    expect(cap.text()).toContain("consolidated 2 → 1 preference(s).");
    expect(cap.text()).toContain("- be terse");
    // consolidated items carry no per-task evidence counts:
    expect(cap.text()).not.toContain("stated in 2 of 2");
  });

  it("consolidation failure exits 1 with the reason and the deterministic fallback block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const runner: RunnerFn = (async () => {
      throw new Error("claude reported an error: API Error: 400 data retention mode");
    }) as RunnerFn;
    const code = await runPreferences(
      { home, consolidate: true, yes: true },
      { output: cap.out, runner },
    );
    expect(code).toBe(1);
    expect(cap.text()).toContain("consolidation failed: claude reported an error");
    expect(cap.text()).not.toContain("at runClaude"); // reason, not a stack trace
    // still yields the usable deterministic artifact:
    expect(cap.text()).toContain("## Working preferences");
    expect(cap.text()).toContain("- be terse");
  });

  it("plain mode: enter (default yes) copies the exact rendered block and shows the target", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences(
      { home },
      { output: cap.out, input: inputWith("\n"), clipboard: clip.copy },
    );
    expect(code).toBe(0);
    // clipboard received the exact rendered block (no trailing newline).
    const prefs = aggregatePreferences([
      entry("t-one-a", [{ text: "be terse", evidence: "e" }]),
      entry("t-two-b", [{ text: "Be terse!", evidence: "e" }]),
    ]);
    const expected = renderPreferencesBlock(prefs, 2, "claude");
    expect(clip.calls).toHaveLength(1);
    expect(clip.calls[0]?.replace(/generated \d{4}-\d{2}-\d{2}/, "generated DATE")).toBe(
      expected.replace(/generated \d{4}-\d{2}-\d{2}/, "generated DATE"),
    );
    expect(cap.text()).toContain("copied (");
    expect(cap.text()).toContain("CLAUDE.md");
  });

  it("plain mode: answering n skips the copy entirely", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences(
      { home },
      { output: cap.out, input: inputWith("n\n"), clipboard: clip.copy },
    );
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(0);
    expect(cap.text()).not.toContain("copied (");
  });

  it("plain mode: no input stream (pipe/CI) never offers a copy", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const code = await runPreferences({ home }, { output: cap.out, clipboard: clip.copy });
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(0);
    expect(cap.text()).not.toContain("copied (");
    expect(cap.text()).not.toContain("Copy block to clipboard?");
  });

  it("--consolidate with --yes copies the consolidated block", async () => {
    const home = tmpHome();
    writeLibraryEntry(home, entry("t-one-a", [{ text: "be terse", evidence: "e" }]));
    writeLibraryEntry(home, entry("t-two-b", [{ text: "keep answers terse", evidence: "e" }]));
    const cap = capture();
    const clip = fakeClipboard();
    const runner: RunnerFn = (async () => ({
      preferences: [{ text: "be terse", merged_from: 2 }],
    })) as RunnerFn;
    const code = await runPreferences(
      { home, consolidate: true, yes: true },
      { output: cap.out, runner, clipboard: clip.copy },
    );
    expect(code).toBe(0);
    expect(clip.calls).toHaveLength(1);
    // the consolidated block is a flat list with no per-task evidence counts.
    expect(clip.calls[0]).toContain("- be terse");
    expect(clip.calls[0]).not.toContain("stated in");
    expect(cap.text()).toContain("copied (1 preference(s)");
  });
});
