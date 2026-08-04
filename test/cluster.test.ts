import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildClusterPrompt, CLUSTER_PROMPT_VERSION } from "../src/claude/prompts/cluster.js";
import type { RunClaudeOptions } from "../src/claude/runner.js";
import { DEFAULT_TIMEOUT_MS } from "../src/claude/runner.js";
import type { Cluster, Digest } from "../src/claude/schemas.js";
import {
  CLUSTER_TIMEOUT_PER_DIGEST_MS,
  canonicalizeClusterIds,
  loadTasks,
  type RunnerFn,
  runClusterStage,
  saveTasks,
  synthesizeNoGroupTasks,
  validateCluster,
} from "../src/distill/pipeline.js";

// --- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-cluster-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function digest(goal: string): Digest {
  return { goal, deliverable: "d", domain: "dom", keywords: ["k"], outcome: "completed" };
}

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

const DIGESTS: Record<string, Digest> = {
  "webapp-a1.md": digest("build auth"),
  "webapp-b2.md": digest("fix auth bug"),
  "cli-c3.md": digest("quick question"),
};
const IDS = Object.keys(DIGESTS).sort();

const VALID: Cluster = {
  tasks: [
    {
      slug: "auth-feature-work",
      title: "Auth feature",
      rationale: "same goal",
      members: ["webapp-a1.md", "webapp-b2.md"],
    },
  ],
  misc: ["cli-c3.md"],
};

// --- prompt builder ----------------------------------------------------------

describe("buildClusterPrompt", () => {
  it("includes every digest id, the grouping rules, and misc routing", () => {
    const prompt = buildClusterPrompt(DIGESTS);
    for (const id of IDS) expect(prompt).toContain(`- id: ${id}`);
    expect(prompt).toContain("many-to-one");
    expect(prompt).toContain("kebab-case");
    expect(prompt).toContain('"misc"');
    expect(prompt).toContain("dual membership");
    expect(prompt).toContain("never invent new ids");
    expect(prompt).toContain("VERBATIM");
    expect(prompt).toContain("including its `.md`");
    expect(prompt).toContain("build auth");
  });

  it("has a version constant for provenance", () => {
    expect(CLUSTER_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

// --- validation ----------------------------------------------------------------

describe("validateCluster", () => {
  it("accepts a valid clustering (incl. dual membership)", () => {
    expect(validateCluster(VALID, IDS)).toEqual([]);
    const dual: Cluster = {
      tasks: [
        { slug: "auth-work", title: "t", rationale: "r", members: ["webapp-a1.md"] },
        {
          slug: "bug-hunting",
          title: "t",
          rationale: "a1 served two goals",
          members: ["webapp-a1.md", "webapp-b2.md"],
        },
      ],
      misc: ["cli-c3.md"],
    };
    expect(validateCluster(dual, IDS)).toEqual([]);
  });

  it("rejects duplicate slugs", () => {
    const bad: Cluster = {
      tasks: [
        { slug: "auth-work", title: "t", rationale: "r", members: ["webapp-a1.md"] },
        { slug: "auth-work", title: "t", rationale: "r", members: ["webapp-b2.md"] },
      ],
      misc: ["cli-c3.md"],
    };
    expect(validateCluster(bad, IDS).join()).toContain('duplicate slug "auth-work"');
  });

  it("rejects dropped sessions (coverage)", () => {
    const bad: Cluster = {
      tasks: [{ slug: "auth-work", title: "t", rationale: "r", members: ["webapp-a1.md"] }],
      misc: [],
    };
    const problems = validateCluster(bad, IDS).join();
    expect(problems).toContain('"webapp-b2.md" was dropped');
    expect(problems).toContain('"cli-c3.md" was dropped');
  });

  it("rejects invented ids and malformed slugs", () => {
    const bad: Cluster = {
      tasks: [
        { slug: "Bad Slug!", title: "t", rationale: "r", members: ["ghost.md", "webapp-a1.md"] },
        { slug: "one", title: "t", rationale: "r", members: ["webapp-b2.md"] },
        {
          slug: "way-too-many-words-in-this-slug",
          title: "t",
          rationale: "r",
          members: ["cli-c3.md"],
        },
      ],
      misc: ["phantom.md"],
    };
    const problems = validateCluster(bad, IDS).join("\n");
    expect(problems).toContain('unknown session "ghost.md"');
    expect(problems).toContain('unknown session "phantom.md"');
    expect(problems).toContain('slug "Bad Slug!" is not');
    expect(problems).toContain('slug "one" is not');
    expect(problems).toContain('slug "way-too-many-words-in-this-slug" is not');
  });

  it("rejects empty tasks", () => {
    const bad: Cluster = {
      tasks: [{ slug: "empty-task", title: "t", rationale: "r", members: [] }],
      misc: [...IDS],
    };
    expect(validateCluster(bad, IDS).join()).toContain('"empty-task" has no members');
  });
});

// --- no-group synthesis ---------------------------------------------------------

describe("synthesizeNoGroupTasks", () => {
  it("makes one task per session, deterministically, no misc", () => {
    const cluster = synthesizeNoGroupTasks(DIGESTS);
    expect(cluster.tasks).toHaveLength(3);
    expect(cluster.misc).toEqual([]);
    expect(cluster.tasks.map((t) => t.members)).toEqual([
      ["cli-c3.md"],
      ["webapp-a1.md"],
      ["webapp-b2.md"],
    ]);
    expect(validateCluster(cluster, IDS)).toEqual([]);
    // Deterministic across calls:
    expect(synthesizeNoGroupTasks(DIGESTS)).toEqual(cluster);
    // Titles come from digest goals:
    expect(cluster.tasks[1]?.title).toBe("build auth");
  });

  it("disambiguates colliding slugs", () => {
    const cluster = synthesizeNoGroupTasks({
      "same-name.md": digest("a"),
      "same_name.md": digest("b"),
    });
    const slugs = cluster.tasks.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(validateCluster(cluster, ["same-name.md", "same_name.md"])).toEqual([]);
  });
});

// --- cluster stage ----------------------------------------------------------------

describe("runClusterStage", () => {
  it("accepts a valid response and writes tasks.json with the generation", async () => {
    const home = tmpHome();
    const runner: RunnerFn = (async () => VALID) as RunnerFn;
    const result = await runClusterStage({
      home,
      digests: DIGESTS,
      generation: "g1",
      runner,
      output: sink(),
    });
    expect(result.resumed).toBe(false);
    expect(result.misc).toEqual(["cli-c3.md"]);
    const cp = loadTasks(home);
    expect(cp?.generation).toBe("g1");
    expect(cp?.tasks[0]?.slug).toBe("auth-feature-work");
  });

  it("retries once with the problems spelled out, then succeeds", async () => {
    const home = tmpHome();
    const bad: Cluster = { tasks: VALID.tasks, misc: [] }; // drops cli-c3.md
    const prompts: string[] = [];
    let call = 0;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      prompts.push(opts.prompt);
      return call++ === 0 ? bad : VALID;
    }) as RunnerFn;

    const result = await runClusterStage({
      home,
      digests: DIGESTS,
      generation: "g1",
      runner,
      output: sink(),
    });
    expect(call).toBe(2);
    expect(prompts[1]).toContain("previous grouping had these problems");
    expect(prompts[1]).toContain('"cli-c3.md" was dropped');
    expect(result.tasks).toEqual(VALID.tasks);
  });

  it("throws after a second invalid response; no checkpoint is written", async () => {
    const home = tmpHome();
    const bad: Cluster = { tasks: VALID.tasks, misc: [] };
    const runner: RunnerFn = (async () => bad) as RunnerFn;
    await expect(
      runClusterStage({ home, digests: DIGESTS, generation: "g1", runner, output: sink() }),
    ).rejects.toThrow("failed validation after one retry");
    expect(loadTasks(home)).toBeNull();
  });

  it("resumes from a matching checkpoint without calling the runner", async () => {
    const home = tmpHome();
    saveTasks(home, {
      generation: "g1",
      prompt_version: 1,
      tasks: VALID.tasks,
      misc: VALID.misc,
    });
    const runner: RunnerFn = (async () => {
      throw new Error("must not be called");
    }) as RunnerFn;
    const result = await runClusterStage({
      home,
      digests: DIGESTS,
      generation: "g1",
      runner,
      output: sink(),
    });
    expect(result.resumed).toBe(true);
    expect(result.tasks).toEqual(VALID.tasks);
  });

  it("re-clusters when the generation matches but the input set changed", async () => {
    const home = tmpHome();
    saveTasks(home, {
      generation: "g1",
      prompt_version: 1,
      tasks: [{ slug: "old-grouping", title: "t", rationale: "r", members: ["webapp-a1.md"] }],
      misc: [],
    });
    let called = false;
    const runner: RunnerFn = (async () => {
      called = true;
      return VALID;
    }) as RunnerFn;
    const result = await runClusterStage({
      home,
      digests: DIGESTS, // three ids now, checkpoint covered one
      generation: "g1",
      runner,
      output: sink(),
    });
    expect(called).toBe(true);
    expect(result.resumed).toBe(false);
    expect(loadTasks(home)?.tasks[0]?.slug).toBe("auth-feature-work");
  });

  it("--no-group synthesizes deterministically and never calls the runner", async () => {
    const home = tmpHome();
    const runner: RunnerFn = (async () => {
      throw new Error("must not be called");
    }) as RunnerFn;
    const result = await runClusterStage({
      home,
      digests: DIGESTS,
      generation: "g1",
      noGroup: true,
      runner,
      output: sink(),
    });
    expect(result.tasks).toHaveLength(3);
    expect(result.misc).toEqual([]);
    expect(loadTasks(home)?.generation).toBe("g1");
  });

  it("scales the default timeout with the digest count (single call over the corpus)", async () => {
    const home = tmpHome();
    const seen: (number | undefined)[] = [];
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      seen.push(opts.timeoutMs);
      return VALID;
    }) as RunnerFn;
    await runClusterStage({ home, digests: DIGESTS, generation: "g1", runner, output: sink() });
    expect(seen).toEqual([DEFAULT_TIMEOUT_MS + CLUSTER_TIMEOUT_PER_DIGEST_MS * IDS.length]);
  });

  it("passes an explicit --timeout through unscaled, including on the corrective retry", async () => {
    const home = tmpHome();
    const bad: Cluster = { tasks: VALID.tasks, misc: [] }; // drops cli-c3.md → one retry
    const seen: (number | undefined)[] = [];
    let call = 0;
    const runner: RunnerFn = (async (opts: RunClaudeOptions<unknown>) => {
      seen.push(opts.timeoutMs);
      return call++ === 0 ? bad : VALID;
    }) as RunnerFn;
    await runClusterStage({
      home,
      digests: DIGESTS,
      generation: "g1",
      timeoutMs: 42_000,
      runner,
      output: sink(),
    });
    expect(seen).toEqual([42_000, 42_000]);
  });
});

describe("canonicalizeClusterIds", () => {
  const IDS2 = ["proj-aaaa1111.md", "proj-bbbb2222.md"];

  it("repairs ids returned without their .md extension (observed sonnet failure mode)", () => {
    const raw: Cluster = {
      tasks: [{ slug: "some-task-here", title: "t", rationale: "r", members: ["proj-aaaa1111"] }],
      misc: ["proj-bbbb2222"],
    };
    const fixed = canonicalizeClusterIds(raw, IDS2);
    expect(fixed.tasks[0]?.members).toEqual(["proj-aaaa1111.md"]);
    expect(fixed.misc).toEqual(["proj-bbbb2222.md"]);
    expect(validateCluster(fixed, IDS2)).toEqual([]);
    // input is not mutated
    expect(raw.tasks[0]?.members).toEqual(["proj-aaaa1111"]);
  });

  it("leaves already-valid and genuinely unknown ids untouched", () => {
    const raw: Cluster = {
      tasks: [
        {
          slug: "some-task-here",
          title: "t",
          rationale: "r",
          members: ["proj-aaaa1111.md", "invented-id.md"],
        },
      ],
      misc: [],
    };
    const fixed = canonicalizeClusterIds(raw, IDS2);
    expect(fixed.tasks[0]?.members).toEqual(["proj-aaaa1111.md", "invented-id.md"]);
    expect(validateCluster(fixed, IDS2).join(";")).toContain("invented-id.md");
  });

  it("repairs by re-appending .md only — no recursive stripping", () => {
    // stem map is built by stripping exactly one .md from known ids, so a
    // member like "x.md.md" (stem "x.md") matches nothing and passes through.
    const raw: Cluster = {
      tasks: [
        {
          slug: "some-task-here",
          title: "t",
          rationale: "r",
          members: ["proj-aaaa1111.md.md"],
        },
      ],
      misc: [],
    };
    const fixed = canonicalizeClusterIds(raw, IDS2);
    expect(fixed.tasks[0]?.members).toEqual(["proj-aaaa1111.md.md"]);
  });

  it("lets runClusterStage accept an extensionless response without a retry", async () => {
    const home = tmpHome();
    const digests: Record<string, Digest> = {
      "proj-aaaa1111.md": digest("goal a"),
      "proj-bbbb2222.md": digest("goal b"),
    };
    let calls = 0;
    const runner: RunnerFn = (async (_opts: RunClaudeOptions<unknown>) => {
      calls++;
      return {
        tasks: [
          {
            slug: "some-task-here",
            title: "T",
            rationale: "same goal",
            members: ["proj-aaaa1111", "proj-bbbb2222"],
          },
        ],
        misc: [],
      };
    }) as RunnerFn;
    const result = await runClusterStage({
      home,
      digests,
      generation: "gen-x",
      noGroup: false,
      runner,
      output: sink(),
    });
    expect(calls).toBe(1); // no corrective retry needed
    expect(result.tasks[0]?.members).toEqual(["proj-aaaa1111.md", "proj-bbbb2222.md"]);
    expect(loadTasks(home)?.tasks[0]?.members).toEqual(["proj-aaaa1111.md", "proj-bbbb2222.md"]);
  });
});
