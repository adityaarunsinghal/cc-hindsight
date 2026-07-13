import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDigestPrompt,
  capContent,
  DIGEST_CONTENT_CAP,
  DIGEST_PROMPT_VERSION,
} from "../src/claude/prompts/digest.js";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import type { Digest } from "../src/claude/schemas.js";
import type { ManifestEntry } from "../src/commands/distill.js";
import {
  clearCheckpoints,
  loadDigests,
  newGeneration,
  type RunnerFn,
  runDigestStage,
  saveDigests,
} from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-pipeline-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function entry(name: string): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project: "x",
    sessionId: name,
    messages: 3,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

function writeExport(home: string, name: string, content = `### t\n\ncontent of ${name}\n`): void {
  fs.writeFileSync(path.join(home, "exports", name), content);
}

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

const DIGEST: Digest = {
  goal: "ship the feature",
  deliverable: "a PR",
  domain: "webapp",
  keywords: ["feature"],
  outcome: "completed",
};

// --- capContent / prompt builder --------------------------------------------

describe("capContent", () => {
  it("passes short content through untouched", () => {
    expect(capContent("hello", 100)).toBe("hello");
  });

  it("caps monsters to exactly the cap with head+tail and a truncation note", () => {
    const content = `HEAD${"x".repeat(10_000)}TAIL`;
    const capped = capContent(content, 1_000);
    expect(capped.length).toBe(1_000);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).toContain("truncated");
    expect(capped).toContain("characters from the middle");
  });

  it("defaults to the 50k cap", () => {
    const capped = capContent("y".repeat(DIGEST_CONTENT_CAP + 5_000));
    expect(capped.length).toBe(DIGEST_CONTENT_CAP);
  });
});

describe("buildDigestPrompt", () => {
  it("labels outcome evidence and marks the assistant tail machine-authored", () => {
    const prompt = buildDigestPrompt({
      exportName: "webapp-a1b2c3d4.md",
      content: "### t\n\ndo the thing\n",
      outcome: {
        final_human_turns: ["do the thing", "yes", "thanks"],
        final_assistant_tail: "All done — tests pass.",
      },
    });
    expect(prompt).toContain("=== OUTCOME EVIDENCE (bounded) ===");
    expect(prompt).toContain("MACHINE-AUTHORED");
    expect(prompt).toContain("All done — tests pass.");
    expect(prompt).toContain('"do the thing"');
    expect(prompt).toContain("webapp-a1b2c3d4.md");
    expect(prompt).toContain('"completed"');
    expect(prompt).toContain('"abandoned"');
  });

  it("falls back to an explicit no-evidence note", () => {
    const prompt = buildDigestPrompt({ exportName: "a.md", content: "hi" });
    expect(prompt).toContain("No outcome evidence was captured");
  });

  it("has a version constant for provenance", () => {
    expect(DIGEST_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

// --- checkpoint plumbing -----------------------------------------------------

describe("checkpoints", () => {
  it("save/load round-trips and clearCheckpoints removes them", () => {
    const home = tmpHome();
    const cp = { generation: "g1", prompt_version: 1, digests: { "a.md": DIGEST } };
    saveDigests(home, cp);
    expect(loadDigests(home)).toEqual(cp);
    clearCheckpoints(home);
    expect(loadDigests(home)).toBeNull();
  });

  it("loadDigests returns null for absent or malformed files", () => {
    const home = tmpHome();
    expect(loadDigests(home)).toBeNull();
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    fs.writeFileSync(path.join(home, "distill", "digests.json"), "not json");
    expect(loadDigests(home)).toBeNull();
  });

  it("mints distinct, sortable generation ids", () => {
    const g1 = newGeneration(new Date("2026-07-13T10:00:00Z"));
    expect(g1).toMatch(/^20260713T100000Z-[0-9a-f]{4}$/);
    expect(newGeneration()).not.toBe(newGeneration());
  });
});

// --- digest stage -------------------------------------------------------------

describe("runDigestStage", () => {
  it("digests every entry, saving the checkpoint incrementally", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");

    const checkpointSizesAtCallTime: number[] = [];
    const runner: RunnerFn = (async () => {
      const cp = loadDigests(home);
      checkpointSizesAtCallTime.push(cp ? Object.keys(cp.digests).length : 0);
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner,
      output: sink(),
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toEqual([]);
    // First call: nothing saved yet; second call: a.md already checkpointed.
    expect(checkpointSizesAtCallTime).toEqual([0, 1]);
    const cp = loadDigests(home);
    expect(cp?.prompt_version).toBe(DIGEST_PROMPT_VERSION);
    expect(Object.keys(cp?.digests ?? {}).sort()).toEqual(["a.md", "b.md"]);
  });

  it("resumes: checkpointed sessions are skipped and never re-run", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    saveDigests(home, { generation: "g1", prompt_version: 1, digests: { "a.md": DIGEST } });

    const calls: string[] = [];
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      calls.push(opts.prompt.includes("content of b.md") ? "b.md" : "other");
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md")],
      runner,
      output: sink(),
    });

    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.generation).toBe("g1"); // resume keeps the generation
    expect(calls).toEqual(["b.md"]);
  });

  it("one failure doesn't abort the rest; progress is kept", async () => {
    const home = tmpHome();
    for (const n of ["a.md", "b.md", "c.md"]) writeExport(home, n);

    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      if (opts.prompt.includes("content of b.md")) throw new Error("boom");
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md"), entry("c.md")],
      runner,
      output: sink(),
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toEqual([{ export: "b.md", error: "boom" }]);
    expect(Object.keys(loadDigests(home)?.digests ?? {}).sort()).toEqual(["a.md", "c.md"]);
  });

  it("passes the DigestSchema through to the runner (outcome validated)", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");

    // A runner that validates its input the way the real runClaude does:
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) =>
      opts.schema.parse({ ...DIGEST, outcome: "not-a-valid-outcome" })) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("a.md")],
      runner,
      output: sink(),
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain("outcome");
  });

  it("feeds outcome evidence from outcomes.json into the prompt", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    fs.writeFileSync(
      path.join(home, "exports", "outcomes.json"),
      JSON.stringify({
        _note: "label",
        "a.md": { final_human_turns: ["looks great"], final_assistant_tail: "Shipped v2." },
      }),
    );

    let prompt = "";
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      return DIGEST;
    }) as RunnerFn;

    await runDigestStage({ home, entries: [entry("a.md")], runner, output: sink() });
    expect(prompt).toContain("Shipped v2.");
    expect(prompt).toContain('"looks great"');
  });

  it("records unreadable exports as failures without invoking the runner", async () => {
    const home = tmpHome();
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("missing.md")],
      runner,
      output: sink(),
    });

    expect(called).toBe(false);
    expect(result.failed[0]?.error).toContain("could not read export");
  });
});
