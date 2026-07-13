import { describe, expect, it } from "vitest";
import {
  type Capabilities,
  ClaudeRunnerError,
  defaultIo,
  probeCapabilities,
  type RunnerIo,
  resetCapabilityCache,
  runClaude,
  type SpawnResult,
} from "../src/claude/runner.js";
import { DigestSchema } from "../src/claude/schemas.js";

// --- fixtures --------------------------------------------------------------

const VALID_DIGEST = {
  goal: "add pagination to /users",
  deliverable: "paginated endpoint",
  domain: "backend",
  keywords: ["api", "pagination"],
  outcome: "completed" as const,
};

const CAPS_MODERN: Capabilities = { jsonSchema: true, disableTools: "tools-empty" };
const CAPS_OLD: Capabilities = { jsonSchema: false, disableTools: "tools-empty" };

/** Build a `claude -p --output-format json` envelope around a result body. */
function envelope(body: unknown, opts: { isError?: boolean } = {}): SpawnResult {
  const result = typeof body === "string" ? body : JSON.stringify(body);
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: opts.isError ?? false,
      result,
      session_id: "sess-1",
      total_cost_usd: 0,
    }),
  };
}

interface MockIo {
  io: RunnerIo;
  calls: Array<{ args: string[]; input: string }>;
}

/** A RunnerIo whose spawn returns a queued sequence of results. */
function mockIo(results: SpawnResult[], which: string | null = "/usr/bin/claude"): MockIo {
  const calls: MockIo["calls"] = [];
  let i = 0;
  const io: RunnerIo = {
    which: () => which,
    spawn: async (_bin, args, opts) => {
      calls.push({ args, input: opts.input });
      const r = results[i++];
      if (!r) throw new Error("unexpected extra spawn call");
      return r;
    },
  };
  return { io, calls };
}

// --- tests -----------------------------------------------------------------

describe("runClaude — success path", () => {
  it("parses the envelope and validates against the schema", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    const out = await runClaude(
      { prompt: "digest this", schema: DigestSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
    expect(calls).toHaveLength(1);
    // schema flag + tool disabling are wired when supported
    expect(calls[0]?.args).toContain("--json-schema");
    expect(calls[0]?.args).toContain("--output-format");
    expect(calls[0]?.args).toContain("--tools");
    // prompt is delivered on stdin
    expect(calls[0]?.input).toContain("digest this");
  });

  it("passes --model through when provided", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    await runClaude(
      { prompt: "p", schema: DigestSchema, model: "opus", capabilities: CAPS_MODERN },
      io,
    );
    expect(calls[0]?.args).toContain("--model");
    expect(calls[0]?.args).toContain("opus");
  });

  it("recovers JSON wrapped in a Markdown code fence", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID_DIGEST)}\n\`\`\``;
    const { io } = mockIo([envelope(fenced)]);
    const out = await runClaude(
      { prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
  });
});

describe("runClaude — retry", () => {
  it("retries exactly once on malformed output then succeeds (2 spawns)", async () => {
    const { io, calls } = mockIo([envelope("this is not json"), envelope(VALID_DIGEST)]);
    const out = await runClaude(
      { prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
    expect(calls).toHaveLength(2);
    // the corrective note is appended on the second attempt only
    expect(calls[0]?.input).not.toContain("previous response could not be used");
    expect(calls[1]?.input).toContain("previous response could not be used");
  });

  it("throws a typed validation error after a second failure", async () => {
    const { io, calls } = mockIo([envelope("nope"), envelope("still nope")]);
    await expect(
      runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io),
    ).rejects.toBeInstanceOf(ClaudeRunnerError);
    expect(calls).toHaveLength(2);

    try {
      const { io: io2 } = mockIo([envelope("nope"), envelope("still nope")]);
      await runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io2);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).kind).toBe("validation");
      expect((e as ClaudeRunnerError).output).toContain("still nope");
    }
  });

  it("does not retry a hard CLI error (is_error envelope)", async () => {
    const { io, calls } = mockIo([envelope("API Error: 403", { isError: true })]);
    try {
      await runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).kind).toBe("cli-error");
    }
    expect(calls).toHaveLength(1);
  });
});

describe("runClaude — binary resolution", () => {
  it("throws a missing-binary error with an install pointer", async () => {
    const { io } = mockIo([], null);
    try {
      await runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).kind).toBe("missing-binary");
      expect((e as ClaudeRunnerError).message).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );
    }
  });
});

describe("runClaude — schema-in-prompt fallback", () => {
  it("embeds the schema in the prompt when --json-schema is unsupported", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    const out = await runClaude(
      { prompt: "base prompt", schema: DigestSchema, capabilities: CAPS_OLD },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
    expect(calls[0]?.args).not.toContain("--json-schema");
    expect(calls[0]?.input).toContain("Respond ONLY with JSON matching this schema");
    // the derived schema (with its enum) is inlined
    expect(calls[0]?.input).toContain("outcome");
    expect(calls[0]?.input).toContain("abandoned");
  });
});

describe("runClaude — tool disabling capability matrix", () => {
  const INSTRUCTION = "Do not use any tools";

  it('tools-empty: passes --tools "" and NO instruction', async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    await runClaude(
      {
        prompt: "p",
        schema: DigestSchema,
        capabilities: { jsonSchema: true, disableTools: "tools-empty" },
      },
      io,
    );
    expect(calls[0]?.args).toContain("--tools");
    expect(calls[0]?.input).not.toContain(INSTRUCTION);
  });

  it("disallowed: NO --tools flag but DOES add the instruction (was a silent no-op)", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    await runClaude(
      {
        prompt: "p",
        schema: DigestSchema,
        capabilities: { jsonSchema: true, disableTools: "disallowed" },
      },
      io,
    );
    expect(calls[0]?.args).not.toContain("--tools");
    expect(calls[0]?.input).toContain(INSTRUCTION);
  });

  it("none: NO --tools flag but DOES add the instruction", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    await runClaude(
      {
        prompt: "p",
        schema: DigestSchema,
        capabilities: { jsonSchema: true, disableTools: "none" },
      },
      io,
    );
    expect(calls[0]?.args).not.toContain("--tools");
    expect(calls[0]?.input).toContain(INSTRUCTION);
  });

  it("disableTools:false suppresses both flag and instruction", async () => {
    const { io, calls } = mockIo([envelope(VALID_DIGEST)]);
    await runClaude(
      {
        prompt: "p",
        schema: DigestSchema,
        disableTools: false,
        capabilities: { jsonSchema: true, disableTools: "tools-empty" },
      },
      io,
    );
    expect(calls[0]?.args).not.toContain("--tools");
    expect(calls[0]?.input).not.toContain(INSTRUCTION);
  });
});

describe("runClaude — timeout", () => {
  it("throws a typed timeout error when the spawn times out", async () => {
    const timedOut: SpawnResult = {
      code: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
    };
    const { io } = mockIo([timedOut]);
    try {
      await runClaude(
        { prompt: "p", schema: DigestSchema, timeoutMs: 50, capabilities: CAPS_MODERN },
        io,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).kind).toBe("timeout");
    }
  });

  it("defaultIo.spawn actually kills a process that exceeds the timeout", async () => {
    const start = Date.now();
    // Portable long-running child (no POSIX `sleep`, so the suite runs on Windows
    // too, L12). SIGTERM should stop it well before the SIGKILL grace elapses.
    const res = await defaultIo.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      input: "",
      timeoutMs: 150,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("swallows EPIPE when the child exits before the prompt is fully written", async () => {
    // A child that exits immediately without reading stdin; writing a large
    // prompt to its closed stdin must NOT crash the process.
    const big = "x".repeat(2_000_000);
    const res = await defaultIo.spawn(process.execPath, ["-e", "process.exit(1)"], {
      input: big,
      timeoutMs: 5_000,
    });
    // We only require that the promise resolves (no uncaught EPIPE). Exit code is
    // reported for the caller to classify.
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(1);
  });
});

describe("probeCapabilities", () => {
  it("detects --json-schema and --tools support", async () => {
    resetCapabilityCache();
    const help: SpawnResult = {
      code: 0,
      signal: null,
      stdout: "--json-schema <schema>\n--tools <tools...>\n--model <m>",
      stderr: "",
      timedOut: false,
    };
    const io: RunnerIo = { which: () => "/x/claude", spawn: async () => help };
    const caps = await probeCapabilities("/x/claude", io);
    expect(caps).toEqual({ jsonSchema: true, disableTools: "tools-empty" });
  });

  it("falls back when --json-schema is absent", async () => {
    resetCapabilityCache();
    const help: SpawnResult = {
      code: 0,
      signal: null,
      stdout: "--disallowed-tools <tools...>\n--model <m>",
      stderr: "",
      timedOut: false,
    };
    const io: RunnerIo = { which: () => "/x/claude", spawn: async () => help };
    const caps = await probeCapabilities("/x/claude", io);
    expect(caps).toEqual({ jsonSchema: false, disableTools: "disallowed" });
  });

  it("caches the probe so it runs once per process", async () => {
    resetCapabilityCache();
    let spawns = 0;
    const io: RunnerIo = {
      which: () => "/x/claude",
      spawn: async () => {
        spawns++;
        return {
          code: 0,
          signal: null,
          stdout: "--json-schema\n--tools",
          stderr: "",
          timedOut: false,
        };
      },
    };
    await probeCapabilities("/x/claude", io);
    await probeCapabilities("/x/claude", io);
    expect(spawns).toBe(1);
    resetCapabilityCache();
  });
});
