import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeRunnerError } from "../src/claude/runner.js";
import { KIRO_NO_TOOLS_AGENT, type KiroEnv, makeKiroRunner, runKiro } from "../src/runners/kiro.js";
import type { RunnerIo, SpawnResult } from "../src/runners/shared.js";
import type { RunOptions } from "../src/runners/types.js";

const Schema = z.object({ ok: z.boolean(), note: z.string() });
type Out = z.infer<typeof Schema>;

const SCRATCH = "/tmp/scratch-run-1";

function spawnResult(over: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...over };
}

/** A KiroEnv whose spawn returns a scripted queue of results; records calls. */
function makeEnv(
  results: SpawnResult[],
  opts: {
    listSessions?: KiroEnv["listSessions"];
    deleteSession?: (id: string) => Promise<void>;
    which?: string | null;
  } = {},
): {
  env: KiroEnv;
  calls: { args: string[]; input: string; cwd?: string }[];
  agentsWritten: { cwd: string; name: string }[];
  deleted: string[];
  sleeps: number[];
} {
  const calls: { args: string[]; input: string; cwd?: string }[] = [];
  const agentsWritten: { cwd: string; name: string }[] = [];
  const deleted: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const io: RunnerIo = {
    which: () => (opts.which === undefined ? "/usr/bin/kiro-cli" : opts.which),
    spawn: async (_bin, args, o) => {
      calls.push({ args, input: o.input, cwd: o.cwd });
      return results[i++] ?? spawnResult();
    },
  };
  const env: KiroEnv = {
    io,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    makeScratch: () => SCRATCH,
    removeScratch: () => {},
    writeAgent: (cwd, name) => agentsWritten.push({ cwd, name }),
    listSessions: opts.listSessions ?? (async () => []),
    deleteSession:
      opts.deleteSession ??
      (async (id) => {
        deleted.push(id);
      }),
  };
  return { env, calls, agentsWritten, deleted, sleeps };
}

const OPTS: RunOptions<Out> = { prompt: "digest this", schema: Schema };

describe("runKiro — happy path", () => {
  it("parses ANSI-decorated, fenced JSON from stdout", async () => {
    // Leading `> ` glyph + ANSI color + a ```json fence — all must be stripped.
    const stdout = '[38;5;141m> [0m```json\n{"ok":true,"note":"hi"}\n```';
    const { env, agentsWritten } = makeEnv([spawnResult({ stdout })]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out).toEqual({ ok: true, note: "hi" });
    // The no-tools agent is written into the scratch cwd before the call.
    expect(agentsWritten).toEqual([{ cwd: SCRATCH, name: KIRO_NO_TOOLS_AGENT }]);
  });

  it("spawns with the no-interactive + agent args and the scratch cwd", async () => {
    const { env, calls } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    await runKiro(OPTS, SCRATCH, env);
    expect(calls[0]?.args).toEqual(["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT]);
    expect(calls[0]?.cwd).toBe(SCRATCH);
    // Prompt carries the self-recognition sentinel as its first line.
    expect(calls[0]?.input.startsWith("[cc-hindsight distill]")).toBe(true);
  });
});

describe("runKiro — empty-stdout transient backoff (below corrective retry)", () => {
  it("retries the SAME input on empty stdout + exit 0, then succeeds", async () => {
    const { env, calls, sleeps } = makeEnv([
      spawnResult({ stdout: "" }), // transient failure 1
      spawnResult({ stdout: "" }), // transient failure 2
      spawnResult({ stdout: '{"ok":true,"note":"recovered"}' }), // success
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("recovered");
    // 3 spawns, 2 backoff sleeps, and NO corrective note (same input each time).
    expect(calls.length).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(calls[0]?.input).toBe(calls[2]?.input);
  });

  it("throws cli-error after exhausting empty-stdout retries", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: "" }),
      spawnResult({ stdout: "" }),
      spawnResult({ stdout: "" }),
    ]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({
      kind: "cli-error",
    });
  });
});

describe("runKiro — corrective retry on bad JSON (above transport retry)", () => {
  it("retries once with a corrective note when stdout is non-empty but unparseable", async () => {
    const { env, calls } = makeEnv([
      spawnResult({ stdout: "here you go: not json at all" }),
      spawnResult({ stdout: '{"ok":true,"note":"fixed"}' }),
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("fixed");
    // Second attempt carries the corrective note.
    expect(calls[1]?.input).toContain("previous response could not be used");
  });

  it("throws validation after a second unparseable response", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: "garbage one" }),
      spawnResult({ stdout: "garbage two" }),
    ]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("runKiro — errors", () => {
  it("throws missing-binary when kiro-cli is absent", async () => {
    const { env } = makeEnv([], { which: null });
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "missing-binary" });
  });

  it("throws cli-error on a non-zero exit", async () => {
    const { env } = makeEnv([spawnResult({ code: 1, stderr: "auth expired" })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "cli-error" });
  });

  it("throws timeout when the spawn times out", async () => {
    const { env } = makeEnv([spawnResult({ timedOut: true })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("errors are AgentRunnerError instances (ClaudeRunnerError alias)", async () => {
    const { env } = makeEnv([spawnResult({ code: 1 })]);
    await expect(runKiro(OPTS, SCRATCH, env)).rejects.toBeInstanceOf(ClaudeRunnerError);
  });
});

describe("kiro runner — session-store cleanup via finalize (deletion-safety invariant)", () => {
  const LISTING = [
    {
      cwd: SCRATCH,
      sessions: [
        { sessionId: "mine-1", title: "[cc-hindsight distill] digest this" },
        { sessionId: "not-mine", title: "some human session that happened to share cwd" },
      ],
    },
    {
      cwd: "/home/user/real-project",
      sessions: [{ sessionId: "REAL", title: "[cc-hindsight distill] looks like ours" }],
    },
  ];

  it("finalize deletes ONLY sentinel-titled sessions in the scratch cwd group — and only ONCE per run, never mid-call", async () => {
    const deleted: string[] = [];
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })], {
      listSessions: async () => LISTING,
      deleteSession: async (id) => {
        deleted.push(id);
      },
    });
    const runner = makeKiroRunner(env);
    await runner.run(OPTS);
    // No cleanup mid-run: a concurrent sibling's in-flight session can never be
    // list-and-deleted by a worker that finished earlier.
    expect(deleted).toEqual([]);
    await runner.finalize?.();
    // Only the scratch-cwd sentinel session is deleted; the other cwd group and
    // the non-sentinel session in-scope both survive.
    expect(deleted).toEqual(["mine-1"]);
  });

  it("finalize cleans up after a failed run too and never throws", async () => {
    const deleted: string[] = [];
    const { env } = makeEnv([spawnResult({ code: 1, stderr: "boom" })], {
      listSessions: async () => [
        { cwd: SCRATCH, sessions: [{ sessionId: "s1", title: "[cc-hindsight distill] x" }] },
      ],
      deleteSession: async (id) => {
        deleted.push(id);
      },
    });
    const runner = makeKiroRunner(env);
    await expect(runner.run(OPTS)).rejects.toMatchObject({ kind: "cli-error" });
    await runner.finalize?.();
    expect(deleted).toEqual(["s1"]); // cleanup still happened, once, at run end
  });

  it("finalize before any call is a no-op (no scratch dir was ever created)", async () => {
    let listed = 0;
    const { env } = makeEnv([], {
      listSessions: async () => {
        listed++;
        return [];
      },
    });
    const runner = makeKiroRunner(env);
    await runner.finalize?.();
    expect(listed).toBe(0);
  });
});

describe("kiro runner — cost accounting (Credits stderr footer)", () => {
  it("accumulates per-call credits into costSummary", async () => {
    const { env } = makeEnv([
      spawnResult({ stdout: '{"ok":true,"note":"a"}', stderr: "▸ Credits: 0.32 • Time: 4s" }),
      spawnResult({ stdout: '{"ok":true,"note":"b"}', stderr: "▸ Credits: 0.5 • Time: 2s" }),
    ]);
    const runner = makeKiroRunner(env);
    expect(runner.costSummary?.()).toBeUndefined(); // nothing spent yet
    await runner.run(OPTS);
    await runner.run(OPTS);
    expect(runner.costSummary?.()).toBe("≈ 0.82 Kiro credits used this run");
  });

  it("stays undefined when stderr carries no credits line", async () => {
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"a"}' })]);
    const runner = makeKiroRunner(env);
    await runner.run(OPTS);
    expect(runner.costSummary?.()).toBeUndefined();
  });
});

describe("kiro runner — scratch cwd location", () => {
  it("threads the home-scoped scratchBase into env.makeScratch", async () => {
    const bases: (string | undefined)[] = [];
    const { env } = makeEnv([spawnResult({ stdout: '{"ok":true,"note":"x"}' })]);
    const recordingEnv: KiroEnv = {
      ...env,
      makeScratch: (base?: string) => {
        bases.push(base);
        return SCRATCH;
      },
    };
    const runner = makeKiroRunner(recordingEnv, "/home/u/.cc-hindsight/runner-scratch");
    await runner.run(OPTS);
    expect(bases).toEqual(["/home/u/.cc-hindsight/runner-scratch"]);
  });
});

describe("runKiro — sentinel echo in output (negative fixture)", () => {
  it("a sentinel-echoing non-JSON response feeds the corrective retry, never store corruption", async () => {
    // The model parrots the K13 sentinel back: the line is not valid JSON, so
    // it must land in the corrective retry — the store is untouched either way
    // (cleanup scope + K13 protect it).
    const { env, calls } = makeEnv([
      spawnResult({ stdout: '> [cc-hindsight distill] {"ok":true,"note":"echoed"}' }),
      spawnResult({ stdout: '{"ok":true,"note":"clean"}' }),
    ]);
    const out = await runKiro(OPTS, SCRATCH, env);
    expect(out.note).toBe("clean");
    expect(calls[1]?.input).toContain("previous response could not be used");
  });
});
