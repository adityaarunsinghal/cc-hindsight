import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHOR_PROMPT_VERSION, buildAuthorPrompt } from "../src/claude/prompts/author.js";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import type { Author, ClusterTask, Digest } from "../src/claude/schemas.js";
import type { ManifestEntry } from "../src/commands/distill.js";
import { oneshotHash } from "../src/core/library.js";
import {
  type RunnerFn,
  runAuthorStage,
  type SourcesJson,
  summarizeOutcomes,
} from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-author-"));
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

function digest(outcome: Digest["outcome"], goal = "ship it"): Digest {
  return { goal, deliverable: "d", domain: "dom", keywords: ["k"], outcome };
}

function task(slug: string, members: string[]): ClusterTask {
  return { slug, title: `Task ${slug}`, rationale: "same goal", members };
}

function entry(name: string): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project: "x",
    sessionId: `sid-${name}`,
    messages: 3,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

const AUTHORED: Author = {
  slug: "auth-feature-work",
  title: "Auth feature",
  oneshot_markdown: "Build the auth flow. Keep it simple, test it properly.",
  confidence: "high",
  preferences: [{ text: "diagnose before acting", evidence: "said so twice" }],
};

const PROMPT = buildAuthorPrompt({
  task: task("auth-feature-work", ["a.md"]),
  members: [
    {
      exportName: "a.md",
      content: "### t\n\nbuild auth\n",
      digest: digest("completed"),
      anaphora: [
        {
          index: 1,
          timestamp: "t",
          human_text: "yes",
          antecedent: "Shall I use JWT?",
          decision_kind: "plan",
          decision_text: "## Plan\nUse JWT",
        },
      ],
    },
  ],
});

// --- prompt-contract tests — pin the realism instructions -----------

describe("author prompt contract", () => {
  it("pins the knowable-at-t=0 test", () => {
    expect(PROMPT).toContain('THE "KNOWABLE AT t=0" TEST');
    expect(PROMPT).toContain("BEFORE the session started");
  });

  it("pins the front-load list", () => {
    expect(PROMPT).toContain("the goal and the concrete deliverable");
    expect(PROMPT).toContain("output format and the quality bar");
    expect(PROMPT).toContain("standing preferences and working style");
    expect(PROMPT).toContain("constraints and things to avoid");
    expect(PROMPT).toContain("decisions the human resolved mid-session");
  });

  it("pins the never-front-load list", () => {
    expect(PROMPT).toContain("NEVER front-load");
    expect(PROMPT).toContain("file paths first seen mid-session");
    expect(PROMPT).toContain("root causes");
    expect(PROMPT).toContain("specific config values or mechanisms");
    expect(PROMPT).toContain("error messages");
    expect(PROMPT).toContain("visibly learned along the way");
  });

  it("pins transform-don't-leak", () => {
    expect(PROMPT).toContain("Transform, don't leak");
    expect(PROMPT).toContain("never the answer the investigation found");
  });

  it("pins the effort budget and structure cap", () => {
    expect(PROMPT).toContain("THE EFFORT BUDGET");
    expect(PROMPT).toContain("100-300");
    expect(PROMPT).toContain("prose-first, minimal structure");
    expect(PROMPT).toContain("not a spec with nested");
  });

  it("pins the never-copy-assistant-prose rule and verbatim decisions", () => {
    expect(PROMPT).toContain("never copy assistant prose");
    expect(PROMPT).toContain("[decision] lines are the human's verbatim choices — honor them");
  });

  it("pins inferred voice (never an asserted persona)", () => {
    expect(PROMPT).toContain("first person");
    expect(PROMPT).toContain("terse if they're terse");
    expect(PROMPT).toContain("never an asserted persona");
  });

  it("pins outcome-aware confidence and preference evidence", () => {
    expect(PROMPT).toContain("CONFIDENCE");
    expect(PROMPT).toContain("rather than overclaim");
    expect(PROMPT).toContain("PREFERENCES");
    expect(PROMPT).toContain("one-line");
    expect(PROMPT).toContain("evidence");
  });

  it("includes task context, member content, outcomes, and anaphora", () => {
    expect(PROMPT).toContain("slug: auth-feature-work");
    expect(PROMPT).toContain("a.md: completed");
    expect(PROMPT).toContain("build auth");
    expect(PROMPT).toContain("this approved a proposed plan");
    expect(PROMPT).toContain("Use JWT");
    expect(PROMPT).toContain("MACHINE-AUTHORED");
  });

  it("has a version constant and inlines member content verbatim (budget is the pipeline's job)", () => {
    expect(AUTHOR_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
    // The pipeline's budget system blocks or cuts oversized tasks BEFORE they
    // reach the builder, so the builder itself must inline content whole —
    // nothing is ever lost here without disclosure upstream.
    const content = "z".repeat(40_000);
    const big = buildAuthorPrompt({
      task: task("big-task-here", ["m.md"]),
      members: [{ exportName: "m.md", content }],
    });
    expect(big).toContain(content);
    expect(big).not.toContain("truncated");
  });
});

// --- outcome summary ----------------------------------------------------------

describe("summarizeOutcomes", () => {
  it("counts outcomes in a stable order", () => {
    const digests = {
      "a.md": digest("completed"),
      "b.md": digest("partial"),
      "c.md": digest("completed"),
      "d.md": digest("unclear"),
    };
    expect(summarizeOutcomes(["a.md", "b.md", "c.md", "d.md"], digests)).toBe(
      "2 completed, 1 partial, 1 unclear",
    );
    expect(summarizeOutcomes(["missing.md"], {})).toBe("1 unclear");
  });
});

// --- author stage ---------------------------------------------------------------

describe("runAuthorStage", () => {
  function writeExport(home: string, name: string): void {
    fs.writeFileSync(path.join(home, "exports", name), `### t\n\ncontent of ${name}\n`);
  }

  const baseOpts = (home: string) => ({
    home,
    entries: [entry("a.md"), entry("b.md")],
    generation: "g1",
    toolVersion: "0.1.0",
    output: sink(),
  });

  it("writes the oneshot file and sources.json with full provenance", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(result.authored).toEqual(["auth-feature-work"]);
    const dir = path.join(home, "library", "auth-feature-work");
    const oneshot = fs.readFileSync(path.join(dir, "auth-feature-work.oneshot.md"), "utf8");
    expect(oneshot).toContain("generated by cc-hindsight v0.1.0");
    expect(oneshot).toContain("generation g1");
    expect(oneshot).toContain("sources: a.md");
    expect(oneshot).toContain("# Auth feature");
    expect(oneshot).toContain("Build the auth flow.");

    const sources = JSON.parse(
      fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
    ) as SourcesJson;
    expect(sources).toMatchObject({
      slug: "auth-feature-work",
      title: "Auth feature",
      members: ["a.md"],
      sessionIds: ["sid-a.md"],
      outcome_summary: "1 completed",
      domains: ["dom"],
      confidence: "high",
      model: null,
      prompt_version: AUTHOR_PROMPT_VERSION,
      tool_version: "0.1.0",
      generation: "g1",
    });
    expect(sources.preferences).toEqual(AUTHORED.preferences);
    expect(Date.parse(sources.authored_at)).not.toBeNaN();
  });

  it("records oneshot_hash of the exact written bytes", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    const dir = path.join(home, "library", "auth-feature-work");
    const oneshot = fs.readFileSync(path.join(dir, "auth-feature-work.oneshot.md"), "utf8");
    const sources = JSON.parse(
      fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
    ) as SourcesJson;
    expect(sources.oneshot_hash).toBe(oneshotHash(oneshot));
  });

  it("keeps a hand-edited oneshot on re-author (no claude call) unless --force", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    // Author once with member a.md only.
    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });
    expect(calls).toBe(1);

    // User hand-tunes the oneshot.
    const oneshotPath = path.join(
      home,
      "library",
      "auth-feature-work",
      "auth-feature-work.oneshot.md",
    );
    fs.appendFileSync(oneshotPath, "\nMy own hard-won addition.\n");
    const editedContent = fs.readFileSync(oneshotPath, "utf8");

    // Membership changed → would normally re-author. Edit protection wins.
    const r2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("completed") },
      runner,
    });
    expect(calls).toBe(1); // no new claude call — protected pre-spend
    expect(r2.skipped).toHaveLength(1);
    expect(r2.skipped[0]?.reason).toContain("--force");
    expect(fs.readFileSync(oneshotPath, "utf8")).toBe(editedContent); // untouched

    // --force re-authors and overwrites.
    const r3 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("completed") },
      runner,
      force: true,
    });
    expect(calls).toBe(2);
    expect(r3.authored).toEqual(["auth-feature-work"]);
    expect(fs.readFileSync(oneshotPath, "utf8")).not.toBe(editedContent);
  });

  it("skips tasks with no completed/partial member and never calls the runner", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("doomed-task-here", ["a.md"])],
      digests: { "a.md": digest("abandoned") },
      runner,
    });

    expect(called).toBe(false);
    expect(result.authored).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.slug).toBe("doomed-task-here");
    expect(result.skipped[0]?.reason).toContain("no completed/partial");
    expect(fs.existsSync(path.join(home, "library", "doomed-task-here"))).toBe(false);
  });

  it("resumes: same-generation sources.json is not re-authored; stale generation is", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const dir = path.join(home, "library", "auth-feature-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({ slug: "auth-feature-work", generation: "g1", members: ["a.md"] }),
    );

    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    // Same generation → resumed, no call.
    const r1 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });
    expect(calls).toBe(0);
    expect(r1.resumed).toEqual(["auth-feature-work"]);

    // Stale generation → re-authored.
    const r2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      generation: "g2",
      runner,
    });
    expect(calls).toBe(1);
    expect(r2.authored).toEqual(["auth-feature-work"]);
    const sources = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    expect(sources.generation).toBe("g2");
  });

  it("one task's failure doesn't abort the rest", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      if (opts.prompt.includes("slug: failing-task-here")) throw new Error("boom");
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("failing-task-here", ["a.md"]), task("auth-feature-work", ["b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      runner,
    });

    expect(result.failed).toEqual([{ export: "failing-task-here", error: "boom" }]);
    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work", "sources.json"))).toBe(
      true,
    );
  });

  it("re-authors a same-generation task whose membership changed", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    writeExport(home, "b.md");
    const dir = path.join(home, "library", "auth-feature-work");
    fs.mkdirSync(dir, { recursive: true });
    // Previously authored in g1 with members [a.md].
    fs.writeFileSync(
      path.join(dir, "sources.json"),
      JSON.stringify({ slug: "auth-feature-work", generation: "g1", members: ["a.md"] }),
    );

    let calls = 0;
    const runner: RunnerFn = (async () => {
      calls++;
      return AUTHORED;
    }) as RunnerFn;

    // Same generation g1 but membership grew to [a.md, b.md] (incremental
    // re-cluster). Must re-author, not resume stale content.
    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      generation: "g1",
      runner,
    });

    expect(calls).toBe(1);
    expect(result.authored).toEqual(["auth-feature-work"]);
    const sources = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    expect(sources.members).toEqual(["a.md", "b.md"]);

    // Re-running with the SAME membership now resumes (no further call).
    const result2 = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md", "b.md"])],
      digests: { "a.md": digest("completed"), "b.md": digest("partial") },
      generation: "g1",
      runner,
    });
    expect(calls).toBe(1);
    expect(result2.resumed).toEqual(["auth-feature-work"]);
  });

  it("fails a task whose member export is unreadable instead of authoring a placeholder", async () => {
    const home = tmpHome();
    // Deliberately do NOT write the export for a.md → unreadable member.
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(called).toBe(false);
    expect(result.authored).toEqual([]);
    expect(result.failed[0]?.export).toBe("auth-feature-work");
    expect(result.failed[0]?.error).toContain("unreadable");
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work"))).toBe(false);
  });

  it("blocks an over-budget task under --truncate=never without a runner call", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "never",
    });

    expect(called).toBe(false);
    expect(result.authored).toEqual([]);
    expect(result.failed[0]?.export).toBe("auth-feature-work");
    expect(result.failed[0]?.error).toContain("exceeds the input budget");
    expect(fs.existsSync(path.join(home, "library", "auth-feature-work"))).toBe(false);
  });

  it("cuts an over-budget task under --truncate=extreme and authors it", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    let promptLen = Number.POSITIVE_INFINITY;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      promptLen = opts.prompt.length;
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "extreme",
    });

    expect(result.authored).toEqual(["auth-feature-work"]);
    expect(promptLen).toBeLessThan(5_000);
  });

  it("records input_coverage and truncations in sources.json under --truncate=extreme", async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "exports", "a.md"), "z".repeat(5_000));
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
      budget: 1_000,
      truncate: "extreme",
    });

    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.input_coverage).toBeLessThan(1);
    expect(sources.input_coverage).toBeGreaterThan(0);
    expect(sources.truncations.length).toBeGreaterThan(0);
    expect(sources.truncations[0].export).toBe("a.md");
    expect(sources.truncations[0].dropped_chars).toBeGreaterThan(0);
  });

  it("records full coverage (input_coverage 1, no truncations) when nothing is cut", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => AUTHORED) as RunnerFn;
    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "auth-feature-work", "sources.json"), "utf8"),
    );
    expect(sources.input_coverage).toBe(1);
    expect(sources.truncations).toEqual([]);
  });

  it("uses the task slug for paths even when the response slug differs", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    const runner: RunnerFn = (async () => ({ ...AUTHORED, slug: "rogue-slug-name" })) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("canonical-task-slug", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(fs.existsSync(path.join(home, "library", "canonical-task-slug"))).toBe(true);
    expect(fs.existsSync(path.join(home, "library", "rogue-slug-name"))).toBe(false);
    const sources = JSON.parse(
      fs.readFileSync(path.join(home, "library", "canonical-task-slug", "sources.json"), "utf8"),
    );
    expect(sources.slug).toBe("canonical-task-slug");
  });

  it("feeds anaphora records from anaphora.json into the prompt", async () => {
    const home = tmpHome();
    writeExport(home, "a.md");
    fs.writeFileSync(
      path.join(home, "exports", "anaphora.json"),
      JSON.stringify({
        "a.md": [
          {
            index: 0,
            timestamp: "t",
            human_text: "option 2",
            antecedent: null,
            decision_kind: "question",
            decision_text: "Which db? 1) postgres 2) sqlite",
          },
        ],
      }),
    );
    let prompt = "";
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompt = opts.prompt;
      return AUTHORED;
    }) as RunnerFn;

    await runAuthorStage({
      ...baseOpts(home),
      tasks: [task("auth-feature-work", ["a.md"])],
      digests: { "a.md": digest("completed") },
      runner,
    });

    expect(prompt).toContain('"option 2"');
    expect(prompt).toContain("Which db?");
  });

  // --- concurrency -----------------------------------------------------------
  // A runner that records how many calls are in flight at once, releasing each
  // only after every worker has had a chance to start (a shared barrier). The
  // observed peak proves real overlap rather than accidental interleaving.
  function trackingRunner(target: number): {
    runner: RunnerFn;
    maxActive: () => number;
  } {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: RunnerFn = (async () => {
      active++;
      peak = Math.max(peak, active);
      // Once `target` calls are simultaneously parked, open the gate so they
      // all resolve; with fewer than `target` workers the gate opens when the
      // last-started worker parks (peak then equals the worker count).
      if (active >= target) release();
      await Promise.race([gate, new Promise((r) => setTimeout(r, 250))]);
      active--;
      return AUTHORED;
    }) as RunnerFn;
    return { runner, maxActive: () => peak };
  }

  function manyTasks(home: string, n: number): ClusterTask[] {
    const tasks: ClusterTask[] = [];
    for (let i = 0; i < n; i++) {
      const name = `m${i}.md`;
      fs.writeFileSync(path.join(home, "exports", name), `### t\n\ncontent ${i}\n`);
      tasks.push(task(`task-number-${i}`, [name]));
    }
    return tasks;
  }

  const manyEntries = (n: number): ManifestEntry[] =>
    Array.from({ length: n }, (_, i) => entry(`m${i}.md`));
  const manyDigests = (n: number): Record<string, Digest> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}.md`, digest("completed")]));

  it("runs author calls in parallel up to --concurrency", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 6);
    const { runner, maxActive } = trackingRunner(3);

    const result = await runAuthorStage({
      home,
      entries: manyEntries(6),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(6),
      runner,
      concurrency: 3,
    });

    expect(result.authored).toHaveLength(6);
    expect(maxActive()).toBe(3); // three calls genuinely in flight at once
  });

  it("stays sequential at concurrency 1 (default)", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 4);
    const { runner, maxActive } = trackingRunner(4);

    const result = await runAuthorStage({
      home,
      entries: manyEntries(4),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(4),
      runner,
      concurrency: 1,
    });

    expect(result.authored).toHaveLength(4);
    expect(maxActive()).toBe(1); // never more than one call in flight
  });

  it("reports results in stable task order regardless of completion timing", async () => {
    const home = tmpHome();
    const tasks = manyTasks(home, 5);
    // Resolve in a jittered order so a naive push-on-finish would scramble it.
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      const m = /task-number-(\d+)/.exec(opts.prompt);
      const i = m ? Number(m[1]) : 0;
      await new Promise((r) => setTimeout(r, (5 - i) * 5));
      return AUTHORED;
    }) as RunnerFn;

    const result = await runAuthorStage({
      home,
      entries: manyEntries(5),
      generation: "g1",
      toolVersion: "0.1.0",
      output: sink(),
      tasks,
      digests: manyDigests(5),
      runner,
      concurrency: 5,
    });

    expect(result.authored).toEqual([
      "task-number-0",
      "task-number-1",
      "task-number-2",
      "task-number-3",
      "task-number-4",
    ]);
  });
});
