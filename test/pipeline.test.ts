import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../src/claude/prompts/digest.js";
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

// --- prompt builder ----------------------------------------------------------

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

  it("bounds in-flight calls to --concurrency and checkpoints everything", async () => {
    const home = tmpHome();
    const names = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    for (const n of names) writeExport(home, n);

    let inFlight = 0;
    let maxInFlight = 0;
    const runner: RunnerFn = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: names.map((n) => entry(n)),
      runner,
      output: sink(),
      concurrency: 2,
    });

    expect(result.completed).toBe(5);
    expect(result.failed).toEqual([]);
    expect(maxInFlight).toBe(2); // pool actually parallelizes, and never exceeds the bound
    expect(Object.keys(loadDigests(home)?.digests ?? {}).sort()).toEqual(names);
  });

  it("stage default stays sequential (concurrency omitted → 1 in flight)", async () => {
    const home = tmpHome();
    for (const n of ["a.md", "b.md", "c.md"]) writeExport(home, n);

    let inFlight = 0;
    let maxInFlight = 0;
    const runner: RunnerFn = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return DIGEST;
    }) as RunnerFn;

    await runDigestStage({
      home,
      entries: [entry("a.md"), entry("b.md"), entry("c.md")],
      runner,
      output: sink(),
    });

    expect(maxInFlight).toBe(1);
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

  // Incident replay: a machine-wide misconfiguration (verbose mode reshaping the
  // CLI envelope) made EVERY call fail identically. The stage kept going through
  // all 92 sessions, and because each failure burns the runner's one corrective
  // retry that was ~2 doomed API calls per session before the run collapsed at
  // the clustering stage with nothing to show. Per-session containment is right
  // for a session-specific problem, but an unbroken streak of identical failures
  // is an environment problem: stop and say so while it is still cheap.
  describe("systemic-failure circuit breaker", () => {
    it("stops the stage after a streak of identical failures", async () => {
      const home = tmpHome();
      const names = Array.from({ length: 20 }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);

      let calls = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        throw new Error("claude envelope missing a 'result' field");
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
      });

      // Far fewer calls than sessions: the streak was cut short.
      expect(calls).toBeLessThan(names.length);
      expect(result.aborted).toBe(true);
      expect(result.abortReason).toContain("identical");
      // Everything not attempted is reported, never silently dropped.
      expect(result.failed.length + result.notAttempted.length).toBe(names.length);
      expect(result.notAttempted.length).toBeGreaterThan(0);
    });

    it("does NOT trip on failures with differing messages", async () => {
      // Distinct errors read as per-session problems (a corrupt export, an
      // oversized transcript), which is exactly what containment is for.
      const home = tmpHome();
      const names = Array.from({ length: 12 }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);

      let calls = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        throw new Error(`unique failure #${calls}`);
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
      });

      expect(calls).toBe(names.length);
      expect(result.aborted).toBeFalsy();
      expect(result.failed).toHaveLength(names.length);
      expect(result.notAttempted).toHaveLength(0);
    });

    it("does NOT trip when a success interrupts the streak", async () => {
      const home = tmpHome();
      const names = Array.from({ length: 15 }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);

      let calls = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        // Succeed every 3rd call: the environment is clearly usable.
        if (calls % 3 === 0) return DIGEST;
        throw new Error("same message every time");
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
      });

      expect(calls).toBe(names.length);
      expect(result.aborted).toBeFalsy();
      expect(result.completed).toBeGreaterThan(0);
    });

    it("keeps successful digests checkpointed when it does trip", async () => {
      // Aborting must never cost work already paid for.
      const home = tmpHome();
      const names = Array.from({ length: 20 }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);

      let calls = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        if (calls === 1) return DIGEST; // one real success, then a total outage
        throw new Error("claude envelope missing a 'result' field");
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
      });

      expect(result.aborted).toBe(true);
      expect(result.completed).toBe(1);
      expect(Object.keys(loadDigests(home)?.digests ?? {})).toHaveLength(1);
    });

    it("breaker:false (--no-breaker) attempts every session anyway", async () => {
      // The abort message promises this escape hatch, so it has to exist.
      const home = tmpHome();
      const names = Array.from({ length: 20 }, (_, i) => `s${i}.md`);
      for (const n of names) writeExport(home, n);

      let calls = 0;
      const runner: RunnerFn = (async () => {
        calls++;
        throw new Error("claude envelope missing a 'result' field");
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: names.map(entry),
        runner,
        output: sink(),
        concurrency: 1,
        breaker: false,
      });

      expect(calls).toBe(names.length);
      expect(result.aborted).toBeFalsy();
      expect(result.failed).toHaveLength(names.length);
      expect(result.notAttempted).toHaveLength(0);
    });

    it("never trips on a small run (nothing to protect)", async () => {
      const home = tmpHome();
      for (const n of ["a.md", "b.md"]) writeExport(home, n);
      const runner: RunnerFn = (async () => {
        throw new Error("identical");
      }) as RunnerFn;

      const result = await runDigestStage({
        home,
        entries: [entry("a.md"), entry("b.md")],
        runner,
        output: sink(),
        concurrency: 1,
      });

      expect(result.aborted).toBeFalsy();
      expect(result.failed).toHaveLength(2);
    });
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

  it("warns when the digests checkpoint was written by a different prompt version", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    saveDigests(home, {
      generation: "g1",
      prompt_version: DIGEST_PROMPT_VERSION + 99,
      digests: { "a.md": DIGEST },
    });
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    const runner: RunnerFn = (async () => DIGEST) as RunnerFn;
    await runDigestStage({ home, entries: [entry("a.md")], runner, output: out });
    expect(chunks.join("")).toContain("produced by prompt v");
  });

  it("blocks an over-budget session under --truncate=never without a runner call", async () => {
    const home = tmpHome();
    writeExport(home, "big.md", "z".repeat(5_000));
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return DIGEST;
    }) as RunnerFn;

    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });

    const result = await runDigestStage({
      home,
      entries: [entry("big.md")],
      runner,
      output: out,
      budget: 1_000,
      truncate: "never",
    });

    expect(called).toBe(false); // pre-spend block
    expect(result.completed).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.export).toBe("big.md");
    expect(chunks.join("")).toContain("blocked");
    // Nothing was checkpointed for the blocked session.
    expect(loadDigests(home)?.digests["big.md"]).toBeUndefined();
  });

  it("cuts an over-budget session under --truncate=extreme and digests it", async () => {
    const home = tmpHome();
    writeExport(home, "big.md", "z".repeat(5_000));
    let promptLen = 0;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      promptLen = opts.prompt.length;
      return DIGEST;
    }) as RunnerFn;

    const result = await runDigestStage({
      home,
      entries: [entry("big.md")],
      runner,
      output: sink(),
      budget: 1_000,
      truncate: "extreme",
    });

    expect(result.completed).toBe(1);
    expect(result.blocked).toHaveLength(0);
    // The prompt carried the cut content (plus fixed prompt scaffolding).
    expect(promptLen).toBeLessThan(5_000);
    expect(loadDigests(home)?.digests["big.md"]).toBeDefined();
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
