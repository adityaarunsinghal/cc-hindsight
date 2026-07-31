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
import { AuthorSchema, DigestSchema } from "../src/claude/schemas.js";

// --- fixtures --------------------------------------------------------------

const VALID_DIGEST = {
  goal: "add pagination to /users",
  deliverable: "paginated endpoint",
  domain: "backend",
  keywords: ["api", "pagination"],
  outcome: "completed" as const,
};

const VALID_AUTHOR = {
  slug: "users-pagination-work",
  title: "Paginate the users endpoint",
  oneshot_markdown:
    "Add pagination to the /users API endpoint: limit/offset params on the query " +
    "layer, page/pageSize on the route, and pagination metadata in the response. " +
    "Keep the diff small, match the existing handler style, and write tests first.",
  confidence: "high" as const,
  preferences: [],
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

/**
 * Build the `verbose`-mode envelope: a JSON ARRAY of stream events terminated
 * by the `type: "result"` event, which is what the CLI emits under
 * `--output-format json` when verbose mode is on (`--verbose`, or
 * `"verbose": true` in settings.json). Shape copied from a real
 * CLI 2.1.220 run: leading `system`/`assistant` events carry no `result` field,
 * and on the terminal event `type` is NOT the first key — so the parser has to
 * look the event up structurally, not by position.
 */
function verboseEnvelope(body: unknown, opts: { isError?: boolean } = {}): SpawnResult {
  const result = typeof body === "string" ? body : JSON.stringify(body);
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify([
      { type: "system", subtype: "init", session_id: "sess-1", tools: ["Bash", "Read"] },
      { type: "assistant", message: { role: "assistant", content: [] }, session_id: "sess-1" },
      {
        is_error: opts.isError ?? false,
        num_turns: 1,
        session_id: "sess-1",
        total_cost_usd: 0,
        subtype: "success",
        result,
        type: "result",
        uuid: "u-1",
      },
    ]),
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

describe("runClaude — verbose-mode array envelope", () => {
  // Regression: with verbose mode on (`--verbose`, or `"verbose": true` in
  // settings.json) `claude -p --output-format json` emits a JSON ARRAY of
  // stream events rather than a single object. The array has no top-level
  // `result`, so every stage failed with "claude envelope missing a 'result'
  // field", burned its one corrective retry, and the whole distill run died at
  // the clustering call. There is no `--no-verbose` flag to force the object
  // shape, so the parser must accept both.
  it("extracts the result from the terminal result event", async () => {
    const { io, calls } = mockIo([verboseEnvelope(VALID_DIGEST)]);
    const out = await runClaude(
      { prompt: "digest this", schema: DigestSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
    // No wasted retry: the first attempt must succeed.
    expect(calls).toHaveLength(1);
  });

  it("recovers fenced JSON inside an array envelope", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID_DIGEST)}\n\`\`\``;
    const { io } = mockIo([verboseEnvelope(fenced)]);
    const out = await runClaude(
      { prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_DIGEST);
  });

  it("treats an is_error result event as a fatal CLI error (no retry)", async () => {
    const { io, calls } = mockIo([verboseEnvelope("API Error: 403", { isError: true })]);
    try {
      await runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).kind).toBe("cli-error");
      expect((e as ClaudeRunnerError).message).toContain("403");
    }
    expect(calls).toHaveLength(1);
  });

  it("reports a diagnosable error when an array carries no result event", async () => {
    // A truncated/interrupted stream: events but no terminal result. Retryable,
    // and the message must name the real problem rather than the misleading
    // "missing a 'result' field".
    const noResult: SpawnResult = {
      code: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify([{ type: "system", subtype: "init" }, { type: "assistant" }]),
    };
    const { io } = mockIo([noResult, noResult]);
    try {
      await runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeRunnerError);
      expect((e as ClaudeRunnerError).message).toContain("no 'result' event");
    }
  });

  it("reports a diagnosable error for an empty array", async () => {
    const empty: SpawnResult = {
      code: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: "[]",
    };
    const { io } = mockIo([empty, empty]);
    await expect(
      runClaude({ prompt: "p", schema: DigestSchema, capabilities: CAPS_MODERN }, io),
    ).rejects.toBeInstanceOf(ClaudeRunnerError);
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

  it("rejects a stub oneshot body (schema-valid JSON, semantic junk) and recovers on retry", async () => {
    // Incident replay: the author stage once received {"oneshot_markdown":
    // "placeholder"} — perfectly-shaped JSON that a plain string field accepts.
    // The minimum-body floor makes it a validation failure, so the standard
    // corrective retry fires instead of a junk entry being written.
    const stub = { ...VALID_AUTHOR, oneshot_markdown: "placeholder" };
    const { io, calls } = mockIo([envelope(stub), envelope(VALID_AUTHOR)]);
    const out = await runClaude(
      { prompt: "author it", schema: AuthorSchema, capabilities: CAPS_MODERN },
      io,
    );
    expect(out).toEqual(VALID_AUTHOR);
    expect(calls).toHaveLength(2);
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

describe("defaultIo.spawn — a child that outlives its stdout pipe", () => {
  // Root cause of an observed end-of-run hang: `close` fires when the stdio
  // pipes close, NOT when the direct child exits. A CLI that execs a wrapper or
  // starts background helpers (an observed wrapper launches MCP servers) can exit
  // while a grandchild still holds the inherited stdout pipe. The runner then
  // waits on that grandchild, and the timeout is powerless because its SIGTERM
  // goes to a process that is already gone. Observed live: a distill run sat
  // idle for 10+ minutes after its last output with no child of its own.
  it("resolves on child exit instead of waiting for a lingering grandchild", async () => {
    const t0 = Date.now();
    const res = await defaultIo.spawn("/bin/sh", ["-c", "sleep 30 & echo done; exit 0"], {
      input: "",
      timeoutMs: 20_000,
    });
    // Must return as soon as the child exits, not 30s later when `sleep` ends.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    // The output the child DID write is still captured.
    expect(res.stdout).toContain("done");
  }, 40_000);

  it("still captures full output from a normal child", async () => {
    // Guard: the exit-based path must not truncate a well-behaved child that
    // flushes and exits without lingering helpers.
    const res = await defaultIo.spawn(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(200000)); process.stdout.end()"],
      { input: "", timeoutMs: 20_000 },
    );
    expect(res.stdout.length).toBe(200000);
    expect(res.timedOut).toBe(false);
  }, 40_000);

  it("still reports a non-zero exit code", async () => {
    const res = await defaultIo.spawn(process.execPath, ["-e", "process.exit(3)"], {
      input: "",
      timeoutMs: 20_000,
    });
    expect(res.code).toBe(3);
  }, 40_000);
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

  // Regression: a distribution wrapper (one observed in the wild, which sets up
  // credentials and model routing then execs the native binary) documents only ITS
  // OWN options in `--help` and forwards unknown flags through. Its help text
  // advertises neither `--json-schema` nor `--tools`, yet BOTH work when passed.
  // Probing such help under-detects and silently degrades every distill stage to
  // the prompt-embedded schema with tools left on by instruction only. A native
  // `--help` always documents `--output-format` (distill depends on that flag),
  // so its absence marks the text as not-the-native-help and we re-probe.
  const WRAPPER_HELP =
    "CLI wrapper for Claude Code (wrapper distribution).\n" +
    "Unknown flags and subcommands are forwarded to the native binary.\n" +
    "Options:\n  --aws-profile <AWS_PROFILE>\n  --settings <SETTINGS>\n" +
    "  --claude-help  Show help for the native Claude Code binary\n";
  const NATIVE_HELP =
    "Usage: claude [options] [command] [prompt]\n" +
    "  -p, --print\n  --output-format <format>\n  --json-schema <schema>\n" +
    "  --tools <tools...>\n  --model <model>\n";

  it("re-probes past a wrapper --help that hides the native flags", async () => {
    resetCapabilityCache();
    const seen: string[][] = [];
    const io: RunnerIo = {
      which: () => "/x/claude",
      spawn: async (_bin, args) => {
        seen.push(args);
        const stdout = args.includes("--help") ? WRAPPER_HELP : NATIVE_HELP;
        return { code: 0, signal: null, stdout, stderr: "", timedOut: false };
      },
    };
    const caps = await probeCapabilities("/x/claude", io);
    // The native capabilities win: full structured output + hard tool disabling.
    expect(caps).toEqual({ jsonSchema: true, disableTools: "tools-empty" });
    expect(seen.some((a) => a.includes("--claude-help"))).toBe(true);
    resetCapabilityCache();
  });

  it("does NOT re-probe a native --help (one spawn, unchanged behavior)", async () => {
    resetCapabilityCache();
    let spawns = 0;
    const io: RunnerIo = {
      which: () => "/x/claude",
      spawn: async () => {
        spawns++;
        return { code: 0, signal: null, stdout: NATIVE_HELP, stderr: "", timedOut: false };
      },
    };
    const caps = await probeCapabilities("/x/claude", io);
    expect(caps).toEqual({ jsonSchema: true, disableTools: "tools-empty" });
    expect(spawns).toBe(1);
    resetCapabilityCache();
  });

  it("keeps the degraded capabilities when the fallback probe also lacks them", async () => {
    // A genuinely old CLI: no --output-format in help either. The fallback runs
    // and finds nothing better, so we must not invent capabilities.
    resetCapabilityCache();
    const io: RunnerIo = {
      which: () => "/x/claude",
      spawn: async () => ({
        code: 0,
        signal: null,
        stdout: "Usage: claude\n  --model <m>\n",
        stderr: "",
        timedOut: false,
      }),
    };
    const caps = await probeCapabilities("/x/claude", io);
    expect(caps).toEqual({ jsonSchema: false, disableTools: "none" });
    resetCapabilityCache();
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
          // Includes --output-format so this reads as the NATIVE help; without it
          // the wrapper-fallback probe fires and the spawn count is 2 by design.
          stdout: "--output-format <format>\n--json-schema\n--tools",
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
