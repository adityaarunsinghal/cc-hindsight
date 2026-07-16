import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { toJsonSchema } from "../claude/schemas.js";
import { KIRO_DISTILL_SENTINEL } from "../sources/kiro/extract.js";
import {
  AgentRunnerError,
  DEFAULT_TIMEOUT_MS,
  defaultIo,
  RetryableError,
  type RunnerIo,
  type SpawnResult,
  snippet,
  stripFence,
} from "./shared.js";
import type { AgentRunner, RunOptions } from "./types.js";

/**
 * runners/kiro.ts — the kiro-cli runner.
 *
 * Drives `kiro-cli chat --no-interactive` for one distill stage. Unlike claude
 * there is no `--output-format json` envelope, no `--json-schema`, and no
 * `--tools` flag — so this runner:
 *   - embeds the JSON schema in the prompt (+ zod validation on our side);
 *   - disables tools via a local no-tools AGENT config discovered from the
 *     spawn cwd (verified: model reports TOOLS=NONE, no MCP startup);
 *   - strips ANSI + the leading `> ` glyph from stdout before parsing;
 *   - treats EMPTY stdout with exit 0 as a transient transport failure (the
 *     observed "Kiro is having trouble responding" signature) and retries with
 *     bounded backoff BELOW the shared corrective retry;
 *   - cleans up the sessions kiro auto-saves per run, with a hard deletion-scope
 *     invariant (only the run's own scratch-cwd group, sentinel-title matched).
 *
 * Verified against kiro-cli 2.12.1 on Linux.
 */

/** Pointer shown when the `kiro-cli` binary cannot be found on PATH. */
export const KIRO_INSTALL_HINT =
  "`kiro-cli` not found on PATH. Install Kiro CLI (Amazon internal: `toolbox install kiro-cli`; " +
  "public: see the Kiro docs). Deterministic commands (scan/export) work without it — only " +
  "distill needs a runner.";

/** The local no-tools agent the runner writes into each scratch cwd. */
export const KIRO_NO_TOOLS_AGENT = "cc-hindsight-distill";

/** Transient-failure retries (empty stdout, exit 0) below the corrective retry. */
export const KIRO_EMPTY_RETRIES = 2;

/** Backoff (ms) between empty-stdout attempts; injectable for tests. */
const KIRO_EMPTY_BACKOFF_MS = [500, 2000];

/** Injectable sleep so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** kiro-cli session listing shape (`--list-sessions --format json`, per cwd). */
interface KiroSessionListing {
  cwd: string;
  sessions: { sessionId: string; title?: string }[];
}

/** Filesystem + process seam for the kiro runner — injectable for testing. */
export interface KiroEnv {
  io: RunnerIo;
  sleep: Sleep;
  /** Make the per-run scratch dir; returns its absolute path. */
  makeScratch(): string;
  /** Best-effort remove a directory tree (the scratch dir). */
  removeScratch(dir: string): void;
  /** Write the no-tools agent config into `<cwd>/.kiro/agents/<name>.json`. */
  writeAgent(cwd: string, name: string): void;
  /** List kiro sessions for a cwd (parsed `--list-sessions --format json`). */
  listSessions(cwd: string): Promise<KiroSessionListing[]>;
  /** Delete a kiro session by id. */
  deleteSession(sessionId: string): Promise<void>;
}

/** Build the prompt with schema embedded and a self-recognition sentinel. */
function buildKiroPrompt(opts: RunOptions<unknown>): string {
  const json = JSON.stringify(toJsonSchema(opts.schema));
  // The sentinel rides as the first line so the extractor's K13 rejects the
  // session this call auto-saves (self-recognition guard); echoing it into the
  // output is benign — it fails JSON.parse → corrective retry.
  return (
    `${KIRO_DISTILL_SENTINEL}\n${opts.prompt}\n\n` +
    "Do not use any tools; answer directly from the content provided.\n" +
    `Respond ONLY with JSON matching this schema — no prose, no code fences:\n${json}`
  );
}

/** Strip ANSI escapes and a leading `> ` prompt glyph kiro prints on stdout. */
function cleanKiroStdout(stdout: string): string {
  let text = stripVTControlCharacters(stdout).trim();
  if (text.startsWith("> ")) text = text.slice(2).trim();
  else if (text.startsWith(">")) text = text.slice(1).trim();
  return text;
}

/**
 * One spawn + parse-to-raw-JSON attempt, with empty-stdout transport-retry
 * INSIDE (below the shared corrective retry). Empty stdout + exit 0 is a
 * transient kiro backend failure — retrying the SAME input (no corrective note)
 * is correct; burning the single corrective retry on a transport blip would
 * waste it. Non-empty-but-unparseable stdout is a RetryableError (feeds the
 * corrective retry); a non-zero exit is a fatal cli-error.
 */
async function spawnAndParse(
  bin: string,
  args: string[],
  input: string,
  timeoutMs: number,
  cwd: string,
  env: KiroEnv,
): Promise<unknown> {
  let last: SpawnResult | null = null;
  for (let attempt = 0; attempt <= KIRO_EMPTY_RETRIES; attempt++) {
    const result = await env.io.spawn(bin, args, { input, timeoutMs, cwd });
    last = result;
    if (result.timedOut) {
      throw new AgentRunnerError("timeout", `kiro-cli invocation timed out after ${timeoutMs}ms`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    const text = cleanKiroStdout(result.stdout);
    if (text === "") {
      // Empty output. Exit 0 → transient transport failure: back off and retry
      // the same input. Non-zero exit → the CLI itself failed: fatal.
      if (result.code !== 0) {
        throw new AgentRunnerError(
          "cli-error",
          `kiro-cli exited ${result.code}: ${snippet(result.stderr) || "no output"}`,
          { stderr: result.stderr, output: result.stdout },
        );
      }
      if (attempt < KIRO_EMPTY_RETRIES) {
        await env.sleep(KIRO_EMPTY_BACKOFF_MS[attempt] ?? 2000);
        continue;
      }
      throw new AgentRunnerError(
        "cli-error",
        `kiro-cli produced no output after ${KIRO_EMPTY_RETRIES + 1} attempts`,
        { stderr: result.stderr, output: result.stdout },
      );
    }
    // Non-empty output: parse. A non-zero exit alongside real output is still an
    // error; otherwise strip a fence and JSON.parse (retryable if malformed).
    if (result.code !== 0) {
      throw new AgentRunnerError("cli-error", `kiro-cli exited ${result.code}: ${snippet(text)}`, {
        stderr: result.stderr,
        output: result.stdout,
      });
    }
    try {
      return JSON.parse(stripFence(text));
    } catch {
      throw new RetryableError(`kiro-cli output was not valid JSON: ${snippet(text)}`);
    }
  }
  // Unreachable (loop either returns or throws), but keep the type checker happy.
  throw new AgentRunnerError("cli-error", "kiro-cli produced no usable output", {
    stderr: last?.stderr,
    output: last?.stdout,
  });
}

/**
 * Delete only the sessions this run auto-saved — the DELETION-SAFETY INVARIANT.
 * Parse the per-cwd listing, and delete a session ONLY when BOTH hold: its group
 * cwd is EXACTLY the run's scratch dir, AND its title starts with the sentinel.
 * Never touches any other cwd group even if the listing returns several.
 * Best-effort: failures are swallowed (K13 still protects the corpus).
 */
async function cleanupScratchSessions(scratch: string, env: KiroEnv): Promise<void> {
  try {
    const groups = await env.listSessions(scratch);
    for (const group of groups) {
      if (group.cwd !== scratch) continue; // hard scope: only the scratch cwd
      for (const s of group.sessions) {
        if (!s.title?.startsWith(KIRO_DISTILL_SENTINEL)) continue; // belt-and-braces
        try {
          await env.deleteSession(s.sessionId);
        } catch {
          // best-effort per session
        }
      }
    }
  } catch {
    // listing failed — leave it; K13 self-recognition still excludes these.
  }
}

/**
 * Run one distill stage through kiro-cli. Resolves the binary, writes the
 * no-tools agent into the (shared) scratch cwd, then runs the shared
 * corrective-retry loop (max 2) around {@link spawnAndParse} (which itself
 * absorbs transient empty-stdout failures). Cleans up auto-saved sessions after.
 */
export async function runKiro<T>(
  opts: RunOptions<T>,
  scratchCwd: string,
  env: KiroEnv = defaultKiroEnv,
): Promise<T> {
  const bin = await env.io.which("kiro-cli");
  if (!bin) throw new AgentRunnerError("missing-binary", KIRO_INSTALL_HINT);

  env.writeAgent(scratchCwd, KIRO_NO_TOOLS_AGENT);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT];
  if (opts.model) args.push("--model", opts.model);

  const basePrompt = buildKiroPrompt(opts);
  let lastDetail = "";

  try {
    // Shared corrective-retry loop: on a parse/validation problem, retry ONCE
    // with a corrective note (transport blips are already absorbed below).
    for (let attempt = 0; attempt < 2; attempt++) {
      let input = basePrompt;
      if (attempt === 1) {
        input += `\n\nYour previous response could not be used (${lastDetail}). Respond ONLY with valid JSON matching the required schema — no prose, no code fences.`;
      }
      try {
        const raw = await spawnAndParse(bin, args, input, timeoutMs, scratchCwd, env);
        return opts.schema.parse(raw);
      } catch (err) {
        if (err instanceof AgentRunnerError) throw err; // fatal — do not retry
        lastDetail = err instanceof Error ? err.message : String(err);
      }
    }
    throw new AgentRunnerError(
      "validation",
      `kiro-cli response failed schema validation after one retry: ${lastDetail}`,
    );
  } finally {
    await cleanupScratchSessions(scratchCwd, env);
  }
}

// --- default environment (real fs + kiro-cli via the shared IO) ------------

/** Write a `{tools:[], mcpServers:{}}` agent so the model runs with no tools. */
function writeNoToolsAgent(cwd: string, name: string): void {
  const dir = path.join(cwd, ".kiro", "agents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    name,
    description: "cc-hindsight distill runner — no tools, answer from provided content only.",
    prompt: "You distill coding-agent sessions. Answer only from the content provided.",
    tools: [],
    mcpServers: {},
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Run a kiro-cli subcommand purely to capture stdout (cleanup helpers). */
async function kiroCapture(io: RunnerIo, args: string[], cwd: string): Promise<string> {
  const bin = await io.which("kiro-cli");
  if (!bin) return "";
  const result = await io.spawn(bin, args, { input: "", timeoutMs: 30_000, cwd });
  return result.stdout;
}

/** The default kiro environment: real filesystem + real kiro-cli via defaultIo. */
export const defaultKiroEnv: KiroEnv = {
  io: defaultIo,
  sleep: realSleep,
  makeScratch() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "cc-hindsight-kiro-"));
  },
  removeScratch(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },
  writeAgent: writeNoToolsAgent,
  async listSessions(cwd) {
    const raw = await kiroCapture(defaultIo, ["--list-sessions", "--format", "json"], cwd);
    try {
      const parsed = JSON.parse(stripVTControlCharacters(raw).trim());
      return Array.isArray(parsed) ? (parsed as KiroSessionListing[]) : [];
    } catch {
      return [];
    }
  },
  async deleteSession(sessionId) {
    await kiroCapture(defaultIo, ["--delete-session", sessionId], process.cwd());
  },
};

/**
 * The kiro-cli backend as an {@link AgentRunner}. A single per-*run* scratch cwd
 * is created lazily on first use and reused by every stage call (unique per run
 * ⇒ per-cwd listing isolation, concurrency-safe), then removed when the process
 * exits. Session-store cleanup happens after each call via the scope invariant.
 */
export function makeKiroRunner(env: KiroEnv = defaultKiroEnv): AgentRunner {
  let scratch: string | null = null;
  const ensureScratch = (): string => {
    if (scratch === null) {
      scratch = env.makeScratch();
      // Best-effort remove the scratch dir on process exit (the auto-saved
      // sessions are already cleaned per-call via the scope invariant; this is
      // just tidying the local agent-config tmp dir, never corpus safety).
      const dir = scratch;
      process.once("exit", () => env.removeScratch(dir));
    }
    return scratch;
  };
  return {
    name: "kiro",
    installHint: KIRO_INSTALL_HINT,
    run: (opts) => runKiro(opts, ensureScratch(), env),
  };
}

/** The default kiro runner (real environment). */
export const kiroRunner: AgentRunner = makeKiroRunner();
