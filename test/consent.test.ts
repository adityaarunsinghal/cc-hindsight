import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  askYesNo,
  type ConsentResult,
  confirm,
  type DistillPlan,
  renderPlan,
} from "../src/claude/consent.js";
import { parseClampedInt } from "../src/commands/_shared.js";
import { computePlan, type ManifestEntry, runDistill } from "../src/commands/distill.js";
import type { RunnerFn } from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

/** Captured text is ANSI-stripped: this file pins the disclosure copy, not the color. */
function captureOutput(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { out, text: () => stripVTControlCharacters(chunks.join("")) };
}

function inputWith(line: string): Readable {
  const pt = new PassThrough();
  pt.end(line);
  return pt;
}

/** An input stream that ends immediately with no data (EOF, e.g. `< /dev/null`). */
function eofInput(): Readable {
  const pt = new PassThrough();
  pt.end();
  return pt;
}

/** An input stream that throws if anything ever touches it. */
function forbiddenInput(): Readable {
  return new Proxy({} as Readable, {
    get() {
      throw new Error("stdin was accessed but must not be");
    },
  });
}

// --- renderPlan (the exact disclosure copy) ------------------------------------------

/** The copy is the contract; color is presentation. Strip ANSI, pin the bytes. */
const strip = (s: string) => stripVTControlCharacters(s);

describe("renderPlan", () => {
  it("matches the exact disclosure block (right-aligned counts)", () => {
    const expected = [
      "  distill will invoke your local `claude` CLI (your subscription/credits):",
      "    • 14 session digests",
      "    •  1 clustering call",
      "    • ~5 oneshot authoring calls (one per task; exact count known after clustering)",
      "  ≈ 20 invocations total. Nothing is sent anywhere except through your own claude CLI.",
    ].join("\n");
    expect(strip(renderPlan({ digests: 14, cluster: 1, authorEstimate: 5 }))).toBe(expected);
  });

  it("appends a resume note line when checkpoints exist", () => {
    const out = strip(
      renderPlan({
        digests: 14,
        cluster: 1,
        authorEstimate: 5,
        resumeNote: "9 of 14 digests already done; will run 5 + 1 + ~5",
      }),
    );
    expect(out).toContain("  9 of 14 digests already done; will run 5 + 1 + ~5");
    // resume note is the last line
    expect(out.split("\n").at(-1)).toBe("  9 of 14 digests already done; will run 5 + 1 + ~5");
  });

  it("keeps single-digit counts aligned to the widest field", () => {
    const out = strip(renderPlan({ digests: 5, cluster: 1, authorEstimate: 5 }));
    const lines = out.split("\n");
    expect(lines[1]).toBe("    •  5 session digests");
    expect(lines[2]).toBe("    •  1 clustering call");
    expect(lines[3]).toContain("    • ~5 oneshot authoring calls");
  });

  it("shows the extreme-cut disclosure line when a budget is set and sessions are oversized", () => {
    const out = strip(
      renderPlan({
        digests: 3,
        cluster: 1,
        authorEstimate: 1,
        budget: 1000,
        truncate: "extreme",
        oversized: [{ export: "big.md", chars: 5000 }],
      }),
    );
    expect(out).toContain("1 session(s) exceed the 1000-char budget and will be cut middle-out");
  });

  it("reassures that every byte reaches the model when a budget is set and nothing is oversized", () => {
    const out = strip(
      renderPlan({
        digests: 3,
        cluster: 1,
        authorEstimate: 1,
        budget: 400000,
        truncate: "never",
        oversized: [],
      }),
    );
    expect(out).toContain("Every exported byte will reach the model");
  });

  it("omits the coverage line entirely when no budget context is provided (existing callers)", () => {
    const out = strip(renderPlan({ digests: 5, cluster: 1, authorEstimate: 5 }));
    expect(out).not.toContain("budget");
    expect(out).not.toContain("reach the model");
  });
});

// --- confirm ---------------------------------------------------------------

const PLAN: DistillPlan = { digests: 14, cluster: 1, authorEstimate: 5 };

describe("confirm", () => {
  it("dry-run prints the plan and never touches stdin", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, {
      dryRun: true,
      input: forbiddenInput(),
      output: cap.out,
    });
    expect(result).toBe("dry-run");
    expect(cap.text()).toContain("≈ 20 invocations total");
  });

  it("--yes proceeds without touching stdin", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, {
      yes: true,
      input: forbiddenInput(),
      output: cap.out,
    });
    expect(result).toBe("proceed");
    expect(cap.text()).toContain("distill will invoke your local");
  });

  it("interactive 'y' proceeds", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("y\n"), output: cap.out });
    expect(result).toBe("proceed");
  });

  it("interactive 'yes' proceeds", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("yes\n"), output: cap.out });
    expect(result).toBe("proceed");
  });

  it("empty input declines (default No)", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("\n"), output: cap.out });
    expect(result).toBe("declined");
  });

  it("'n' declines", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("n\n"), output: cap.out });
    expect(result).toBe("declined");
  });

  it("EOF (closed stdin, no answer) declines instead of hanging", async () => {
    const cap = captureOutput();
    // Must resolve — a never-resolving promise would hang the test runner.
    const result = await confirm(PLAN, { input: eofInput(), output: cap.out });
    expect(result).toBe("declined");
  });
});

describe("askYesNo — EOF handling", () => {
  it("treats closed stdin as No (declines the --fresh-style gate)", async () => {
    const cap = captureOutput();
    const answer = await askYesNo("Proceed?", { input: eofInput(), output: cap.out });
    expect(answer).toBe(false);
  });
});

// --- distill command wiring (consent + count math) -------------------------

function entry(name: string, project: string, messages: number): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project,
    sessionId: name,
    messages,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

const tmpDirs: string[] = [];
function tmpHome(entries: ManifestEntry[] | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-distill-"));
  tmpDirs.push(dir);
  if (entries) {
    fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "exports", "manifest.json"), JSON.stringify(entries));
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("parseClampedInt (shared min-* parser, L5)", () => {
  it("min-messages semantics: fallback 1, min 1", () => {
    expect(parseClampedInt(undefined, { fallback: 1, min: 1 })).toBe(1);
    expect(parseClampedInt("3", { fallback: 1, min: 1 })).toBe(3);
    expect(parseClampedInt("0", { fallback: 1, min: 1 })).toBe(1);
    expect(parseClampedInt("abc", { fallback: 1, min: 1 })).toBe(1);
  });

  it("min-substance semantics: '0'->1 and '-1'->1 (no parseInt||default surprises)", () => {
    expect(parseClampedInt(undefined, { fallback: 2, min: 1 })).toBe(2);
    expect(parseClampedInt("0", { fallback: 2, min: 1 })).toBe(1);
    expect(parseClampedInt("-1", { fallback: 2, min: 1 })).toBe(1);
    expect(parseClampedInt("abc", { fallback: 2, min: 1 })).toBe(2);
    expect(parseClampedInt("5", { fallback: 2, min: 1 })).toBe(5);
  });
});

describe("computePlan (count math)", () => {
  it("filters by --min-substance and estimates authors at round(eligible/3)", () => {
    const entries = [
      entry("a", "alpha", 5),
      entry("b", "alpha", 3),
      entry("c", "alpha", 1), // excluded (< 2)
      entry("d", "beta", 4),
      entry("e", "beta", 2),
      entry("f", "beta", 10),
    ];
    const plan = computePlan(entries, { minSubstance: 2, noGroup: false });
    expect(plan.digests).toBe(5);
    expect(plan.cluster).toBe(1);
    expect(plan.authorEstimate).toBe(2); // max(1, round(5/3)) = 2
  });

  it("applies the --project filter (case-insensitive substring)", () => {
    const entries = [entry("a", "alpha", 5), entry("b", "beta", 4), entry("c", "beta", 2)];
    const plan = computePlan(entries, { project: "BET", minSubstance: 2, noGroup: false });
    expect(plan.digests).toBe(2);
    expect(plan.eligible.map((e) => e.export)).toEqual(["b", "c"]);
  });

  it("--no-group yields no cluster call and one author per session", () => {
    const entries = [entry("a", "x", 5), entry("b", "x", 3)];
    const plan = computePlan(entries, { minSubstance: 2, noGroup: true });
    expect(plan.cluster).toBe(0);
    expect(plan.authorEstimate).toBe(2);
  });

  it("zeroes everything when nothing is eligible", () => {
    const plan = computePlan([entry("a", "x", 1)], { minSubstance: 2, noGroup: false });
    expect(plan).toMatchObject({ digests: 0, cluster: 0, authorEstimate: 0 });
  });
});

describe("runDistill", () => {
  it("exits 1 with a hint when the manifest is missing", async () => {
    const cap = captureOutput();
    const code = await runDistill({ home: tmpHome(null) }, { output: cap.out });
    expect(code).toBe(1);
    expect(cap.text()).toContain("nothing exported yet");
    expect(cap.text()).toContain("cc-hindsight export");
  });

  it("exits 0 when nothing meets the substance threshold", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 1)]);
    const code = await runDistill({ home }, { output: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("nothing to distill");
  });

  it("passes the computed plan to the consent gate", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 3)]);
    let captured: DistillPlan | undefined;
    const confirmSpy = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    const code = await runDistill(
      { home, "min-substance": "2" },
      { confirm: confirmSpy, output: cap.out },
    );
    expect(code).toBe(0);
    expect(captured).toMatchObject({ digests: 2, cluster: 1, authorEstimate: 1 });
    expect(cap.text()).toContain("digest — 2 session(s):");
  });

  it("exits 2 when consent is declined", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    const confirmSpy = async (): Promise<ConsentResult> => "declined";
    const code = await runDistill({ home }, { confirm: confirmSpy, output: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("declined");
  });

  it("exits 2 (declined) on EOF stdin without --yes, never hanging", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    // Real consent gate (no confirm spy), closed stdin: must resolve to declined.
    const code = await runDistill({ home }, { output: cap.out, input: eofInput() });
    expect(code).toBe(2);
    expect(cap.text()).toContain("declined");
  });

  it("runs the digest stage on proceed and writes the checkpoint", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### 2026-01-01\n\nbuild the thing\n");
    fs.writeFileSync(path.join(home, "exports", "b"), "### 2026-01-02\n\nfix the bug\n");
    const confirmSpy = async (): Promise<ConsentResult> => "proceed";
    const digest = {
      goal: "g",
      deliverable: "d",
      domain: "dom",
      keywords: ["k"],
      outcome: "completed",
    };
    const cluster = {
      tasks: [{ slug: "the-whole-task", title: "t", rationale: "r", members: ["a", "b"] }],
      misc: [],
    };
    const authored = {
      slug: "the-whole-task",
      title: "The Whole Task",
      oneshot_markdown: "Do the whole thing well.",
      confidence: "high",
      preferences: [],
    };
    const runner = (async (opts: { prompt: string }) => {
      if (opts.prompt.includes("grouping Claude Code sessions")) return cluster;
      if (opts.prompt.includes("realistic ideal first prompt")) return authored;
      return digest;
    }) as RunnerFn;
    const code = await runDistill({ home }, { confirm: confirmSpy, output: cap.out, runner });
    expect(code).toBe(0);
    expect(cap.text()).toContain("digest stage: 2/2 done");
    expect(cap.text()).toContain("the-whole-task (2 sessions)");
    expect(cap.text()).toContain("library: 1 entry authored");
    const cp = JSON.parse(fs.readFileSync(path.join(home, "distill", "digests.json"), "utf8"));
    expect(Object.keys(cp.digests).sort()).toEqual(["a", "b"]);
    const tasks = JSON.parse(fs.readFileSync(path.join(home, "distill", "tasks.json"), "utf8"));
    expect(tasks.tasks[0].slug).toBe("the-whole-task");
    const oneshot = fs.readFileSync(
      path.join(home, "library", "the-whole-task", "the-whole-task.oneshot.md"),
      "utf8",
    );
    expect(oneshot).toContain("Do the whole thing well.");
  });

  it("proceeds past a failed digest, authors the rest, and exits 1", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### t\n\nbuild a\n");
    fs.writeFileSync(path.join(home, "exports", "b"), "### t\n\nbuild b\n");
    const confirmSpy = async (): Promise<ConsentResult> => "proceed";
    const digest = {
      goal: "g",
      deliverable: "d",
      domain: "dom",
      keywords: ["k"],
      outcome: "completed",
    };
    const cluster = {
      tasks: [{ slug: "the-only-task", title: "t", rationale: "r", members: ["a"] }],
      misc: [],
    };
    const authored = {
      slug: "the-only-task",
      title: "T",
      oneshot_markdown: "Do it.",
      confidence: "high",
      preferences: [],
    };
    const runner = (async (opts: { prompt: string }) => {
      if (opts.prompt.includes("build b")) throw new Error("boom-b");
      if (opts.prompt.includes("grouping Claude Code sessions")) return cluster;
      if (opts.prompt.includes("realistic ideal first prompt")) return authored;
      return digest;
    }) as RunnerFn;
    const code = await runDistill({ home }, { confirm: confirmSpy, output: cap.out, runner });
    // Exit 1 because a digest failed — but only AFTER authoring the reachable work.
    expect(code).toBe(1);
    expect(cap.text()).toContain("failed sessions");
    expect(cap.text()).toContain("library: 1 entry authored");
    expect(fs.existsSync(path.join(home, "library", "the-only-task", "sources.json"))).toBe(true);
  });

  it("runs end-to-end with --no-group: one task per session, no cluster call", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### t\n\nbuild a\n");
    fs.writeFileSync(path.join(home, "exports", "b"), "### t\n\nbuild b\n");
    const confirmSpy = async (): Promise<ConsentResult> => "proceed";
    const digest = {
      goal: "g",
      deliverable: "d",
      domain: "dom",
      keywords: ["k"],
      outcome: "completed",
    };
    const authored = {
      slug: "ignored-by-task-slug",
      title: "T",
      oneshot_markdown: "Do it.",
      confidence: "high",
      preferences: [],
    };
    let clusterCalls = 0;
    const runner = (async (opts: { prompt: string }) => {
      if (opts.prompt.includes("grouping Claude Code sessions")) {
        clusterCalls++;
        throw new Error("cluster must not be called under --no-group");
      }
      if (opts.prompt.includes("realistic ideal first prompt")) return authored;
      return digest;
    }) as RunnerFn;
    const code = await runDistill(
      { home, group: false },
      { confirm: confirmSpy, output: cap.out, runner },
    );
    expect(code).toBe(0);
    expect(clusterCalls).toBe(0);
    // One library entry per session (1 session = 1 task).
    expect(fs.readdirSync(path.join(home, "library")).length).toBe(2);
  });

  it("refuses pre-spend (exit 1) when a session exceeds the budget under --truncate=never", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("big", "x", 5)]);
    fs.writeFileSync(path.join(home, "exports", "big"), "z".repeat(5_000));
    let confirmCalled = false;
    const confirmSpy = async (): Promise<ConsentResult> => {
      confirmCalled = true;
      return "proceed";
    };
    const runner = (async () => {
      throw new Error("runner must not be called");
    }) as RunnerFn;
    const code = await runDistill(
      { home, "input-budget": "1000" },
      { confirm: confirmSpy, output: cap.out, runner },
    );
    expect(code).toBe(1);
    // Refused BEFORE the consent gate — nothing was spent.
    expect(confirmCalled).toBe(false);
    expect(cap.text()).toContain("exceed the input budget");
    expect(cap.text()).toContain("--truncate=extreme");
  });

  it("--fresh declined keeps checkpoints and exits 2", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    const cpPath = path.join(home, "distill", "digests.json");
    fs.writeFileSync(cpPath, JSON.stringify({ generation: "g", digests: {} }));
    const code = await runDistill(
      { home, fresh: true },
      { output: cap.out, input: inputWith("n\n") },
    );
    expect(code).toBe(2);
    expect(fs.existsSync(cpPath)).toBe(true);
    expect(cap.text()).toContain("checkpoints kept");
  });

  it("--fresh with --yes clears checkpoints without prompting", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### t\n\nhello\n");
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    const cpPath = path.join(home, "distill", "digests.json");
    fs.writeFileSync(
      cpPath,
      JSON.stringify({ generation: "old", prompt_version: 1, digests: { a: {} } }),
    );
    const digest = {
      goal: "g",
      deliverable: "d",
      domain: "dom",
      keywords: ["k"],
      outcome: "partial",
    };
    const cluster = {
      tasks: [{ slug: "fresh-run-task", title: "t", rationale: "r", members: ["a"] }],
      misc: [],
    };
    const authored = {
      slug: "fresh-run-task",
      title: "Fresh",
      oneshot_markdown: "Redo it.",
      confidence: "medium",
      preferences: [],
    };
    const runner = (async (opts: { prompt: string }) => {
      if (opts.prompt.includes("grouping Claude Code sessions")) return cluster;
      if (opts.prompt.includes("realistic ideal first prompt")) return authored;
      return digest;
    }) as RunnerFn;
    const code = await runDistill(
      { home, fresh: true, yes: true },
      { output: cap.out, input: forbiddenInput(), runner },
    );
    expect(code).toBe(0);
    expect(cap.text()).toContain("checkpoints cleared.");
    // Old checkpoint replaced: new generation, freshly digested.
    const cp = JSON.parse(fs.readFileSync(cpPath, "utf8"));
    expect(cp.generation).not.toBe("old");
    expect(Object.keys(cp.digests)).toEqual(["a"]);
  });

  it("--fresh confirmed but MAIN consent declined keeps checkpoints", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    const cpPath = path.join(home, "distill", "digests.json");
    fs.writeFileSync(
      cpPath,
      JSON.stringify({ generation: "keep-me", prompt_version: 1, digests: { a: {} } }),
    );
    // Confirm --fresh (input "y"), then the main consent gate declines: the
    // destructive clear must NOT have happened yet.
    const confirmSpy = async (): Promise<ConsentResult> => "declined";
    const code = await runDistill(
      { home, fresh: true },
      { confirm: confirmSpy, output: cap.out, input: inputWith("y\n") },
    );
    expect(code).toBe(2);
    expect(fs.existsSync(cpPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cpPath, "utf8")).generation).toBe("keep-me");
  });

  it("surfaces a resume note when a digests checkpoint exists", async () => {
    const home = tmpHome([
      entry("a", "x", 5),
      entry("b", "x", 4),
      entry("c", "x", 3),
      entry("d", "x", 2),
    ]);
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "distill", "digests.json"),
      JSON.stringify({ generation: 1, digests: { a: {}, b: {} } }),
    );
    let captured: DistillPlan | undefined;
    const confirmSpy = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    await runDistill({ home }, { confirm: confirmSpy, output: captureOutput().out });
    expect(captured?.resumeNote).toContain("2 of 4 digests already done");
  });

  it("resume note excludes checkpoint digests outside the eligible set", async () => {
    const home = tmpHome([entry("a", "alpha", 5), entry("b", "beta", 4), entry("c", "beta", 3)]);
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    // Checkpoint holds only 'a' (project alpha).
    fs.writeFileSync(
      path.join(home, "distill", "digests.json"),
      JSON.stringify({ generation: 1, digests: { a: {} } }),
    );
    let captured: DistillPlan | undefined;
    const confirmSpy = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    // Filter to beta: eligible = {b, c}; 'a' is not eligible, so nothing is
    // "already done" for this run — no misleading resume note.
    await runDistill(
      { home, project: "beta" },
      { confirm: confirmSpy, output: captureOutput().out },
    );
    expect(captured?.resumeNote).toBeUndefined();
  });

  // --- seamless one-shot flow: offer export when none, offer library after ----
  // A synthetic ~/.claude with real sessions so an offered export produces a
  // genuine manifest and the whole pipeline can run against a stubbed runner.
  const EXPORT_FIXTURE = path.join(import.meta.dirname, "fixtures", "export-home");

  const stubRunner = (): RunnerFn =>
    (async (opts: { prompt: string }) => {
      if (opts.prompt.includes("grouping Claude Code sessions")) {
        // Echo the real export ids from the prompt so the clustering passes
        // validation (every id must land in a task; empty members are rejected).
        const members = [...opts.prompt.matchAll(/^- id: (.+)$/gm)].map((m) => m[1] as string);
        return {
          tasks: [{ slug: "one-shot-task", title: "t", rationale: "r", members }],
          misc: [],
        };
      }
      if (opts.prompt.includes("realistic ideal first prompt")) {
        return {
          slug: "one-shot-task",
          title: "One Shot",
          oneshot_markdown: "Do it well.",
          confidence: "high",
          preferences: [],
        };
      }
      return { goal: "g", deliverable: "d", domain: "dom", keywords: ["k"], outcome: "completed" };
    }) as RunnerFn;

  it("offers to export first when no manifest exists, then continues (interactive yes)", async () => {
    const cap = captureOutput();
    const home = tmpHome(null); // NO manifest
    const code = await runDistill(
      { home, "claude-dir": EXPORT_FIXTURE },
      // First prompt = the export offer (answer y); consent gate then declines
      // on EOF after the single line is consumed.
      { output: cap.out, input: inputWith("y\n"), runner: stubRunner() },
    );
    // The offer ran export → a manifest now exists on disk.
    expect(fs.existsSync(path.join(home, "exports", "manifest.json"))).toBe(true);
    expect(cap.text()).toMatch(/export/i);
    // We consumed the one input line on the export offer; the real consent gate
    // then hit EOF and declined — so the run reached the gate (exit 2), proving
    // the flow continued past export rather than exiting 1 "nothing exported".
    expect(code).toBe(2);
  });

  it("does NOT offer export when there is no way to prompt (piped, no --yes): exits 1 as before", async () => {
    const cap = captureOutput();
    const home = tmpHome(null);
    // No input stream injected and output is not a TTY → cannot prompt.
    const code = await runDistill({ home, "claude-dir": EXPORT_FIXTURE }, { output: cap.out });
    expect(code).toBe(1);
    expect(cap.text()).toContain("nothing exported yet");
    // Export must NOT have run silently.
    expect(fs.existsSync(path.join(home, "exports", "manifest.json"))).toBe(false);
  });

  it("--yes runs export automatically when no manifest exists (true one-shot)", async () => {
    const cap = captureOutput();
    const home = tmpHome(null);
    const code = await runDistill(
      { home, "claude-dir": EXPORT_FIXTURE, yes: true },
      { output: cap.out, input: forbiddenInput(), runner: stubRunner() },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, "exports", "manifest.json"))).toBe(true);
    // Ran clear through to a library entry.
    expect(fs.existsSync(path.join(home, "library"))).toBe(true);
  });

  it("--dry-run with no manifest does NOT run export; explains and exits 1", async () => {
    const cap = captureOutput();
    const home = tmpHome(null);
    const code = await runDistill(
      { home, "claude-dir": EXPORT_FIXTURE, "dry-run": true },
      { output: cap.out, input: forbiddenInput() },
    );
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(home, "exports", "manifest.json"))).toBe(false);
    expect(cap.text()).toContain("export");
  });

  it("offers to show the library after authoring (interactive), printing the table", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### t\n\nbuild the thing\n");
    // Two input lines: consent gate "y", then the show-library offer "y".
    const code = await runDistill(
      { home },
      { output: cap.out, input: inputWith("y\ny\n"), runner: stubRunner() },
    );
    expect(code).toBe(0);
    // The library table header proves the post-distill display fired.
    expect(cap.text()).toContain("Confidence");
    expect(cap.text()).toContain("one-shot-task");
  });

  it("--yes shows the library after authoring without prompting", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    fs.writeFileSync(path.join(home, "exports", "a"), "### t\n\nbuild the thing\n");
    const code = await runDistill(
      { home, yes: true },
      { output: cap.out, input: forbiddenInput(), runner: stubRunner() },
    );
    expect(code).toBe(0);
    expect(cap.text()).toContain("one-shot-task");
    expect(cap.text()).toContain("Confidence");
  });
});
