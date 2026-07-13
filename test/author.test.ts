import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHOR_MEMBER_CAP,
  AUTHOR_PROMPT_VERSION,
  buildAuthorPrompt,
} from "../src/claude/prompts/author.js";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import type { Author, ClusterTask, Digest } from "../src/claude/schemas.js";
import type { ManifestEntry } from "../src/commands/distill.js";
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

// --- prompt-contract tests (§5.10) — pin the realism instructions -----------

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

  it("has a version constant and a member cap", () => {
    expect(AUTHOR_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
    expect(AUTHOR_MEMBER_CAP).toBeGreaterThan(0);
    // Monster member content is capped:
    const big = buildAuthorPrompt({
      task: task("big-task-here", ["m.md"]),
      members: [{ exportName: "m.md", content: "z".repeat(AUTHOR_MEMBER_CAP + 10_000) }],
    });
    expect(big).toContain("truncated");
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
      confidence: "high",
      model: null,
      prompt_version: AUTHOR_PROMPT_VERSION,
      tool_version: "0.1.0",
      generation: "g1",
    });
    expect(sources.preferences).toEqual(AUTHORED.preferences);
    expect(Date.parse(sources.authored_at)).not.toBeNaN();
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
      JSON.stringify({ slug: "auth-feature-work", generation: "g1" }),
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
});
