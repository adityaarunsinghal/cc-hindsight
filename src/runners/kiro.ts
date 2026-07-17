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
  embedSchema,
  RetryableError,
  type RunnerIo,
  runWithCorrectiveRetry,
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
  /**
   * Make the per-run scratch dir; returns its absolute path. When `base` is
   * given (the distill home's `runner-scratch/`), the dir is created under it
   * (owner-only); otherwise it falls back to the OS temp dir.
   */
  makeScratch(base?: string): string;
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
  // The sentinel rides as the first line so the extractor's K13 rejects the
  // session this call auto-saves (self-recognition guard); echoing it into the
  // output is benign — it fails JSON.parse → corrective retry. The schema is
  // ALWAYS embedded (kiro has no --json-schema / envelope) via the same
  // shared wording the claude no-jsonSchema fallback uses.
  const base =
    `${KIRO_DISTILL_SENTINEL}\n${opts.prompt}\n\n` +
    "Do not use any tools; answer directly from the content provided.";
  return embedSchema(base, JSON.stringify(toJsonSchema(opts.schema)));
}

/** Strip ANSI escapes and a leading `> ` prompt glyph kiro prints on stdout. */
function cleanKiroStdout(stdout: string): string {
  let text = stripVTControlCharacters(stdout).trim();
  if (text.startsWith("> ")) text = text.slice(2).trim();
  else if (text.startsWith(">")) text = text.slice(1).trim();
  return text;
}

/** Mutable per-run cost accumulator (kiro prints `Credits: <n>` on stderr). */
export interface KiroCost {
  credits: number;
}

/** Best-effort: pull the `Credits: <n>` figure out of a stderr footer. */
function parseCredits(stderr: string): number {
  const m = stderr.match(/Credits:\s*([0-9]+(?:\.[0-9]+)?)/);
  const n = m?.[1] ? Number.parseFloat(m[1]) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
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
  cost?: KiroCost,
): Promise<unknown> {
  let last: SpawnResult | null = null;
  for (let attempt = 0; attempt <= KIRO_EMPTY_RETRIES; attempt++) {
    const result = await env.io.spawn(bin, args, { input, timeoutMs, cwd });
    last = result;
    if (cost) cost.credits += parseCredits(result.stderr);
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
 *
 * Runs ONCE per distill run (via {@link AgentRunner.finalize}, after all
 * concurrent workers join) — never mid-run, so one worker's cleanup can never
 * list-and-delete a sibling worker's in-flight session.
 */
export async function cleanupScratchSessions(scratch: string, env: KiroEnv): Promise<void> {
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
 * absorbs transient empty-stdout failures). Auto-saved sessions are cleaned up
 * once per run by {@link cleanupScratchSessions} via the runner's `finalize`.
 */
export async function runKiro<T>(
  opts: RunOptions<T>,
  scratchCwd: string,
  env: KiroEnv = defaultKiroEnv,
  cost?: KiroCost,
): Promise<T> {
  const bin = await env.io.which("kiro-cli");
  if (!bin) throw new AgentRunnerError("missing-binary", KIRO_INSTALL_HINT);

  env.writeAgent(scratchCwd, KIRO_NO_TOOLS_AGENT);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["chat", "--no-interactive", "--agent", KIRO_NO_TOOLS_AGENT];
  if (opts.model) args.push("--model", opts.model);

  return runWithCorrectiveRetry(
    buildKiroPrompt(opts),
    opts.schema,
    (input) => spawnAndParse(bin, args, input, timeoutMs, scratchCwd, env, cost),
    (lastDetail) =>
      new AgentRunnerError(
        "validation",
        `kiro-cli response failed schema validation after one retry: ${lastDetail}`,
      ),
  );
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
  makeScratch(base) {
    // Home-scoped per the plan (<home>/runner-scratch/run-*): owner-only, easy
    // to find/debug, and unique per run. OS tmpdir is the no-home fallback.
    if (base) {
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      return fs.mkdtempSync(path.join(base, "run-"));
    }
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
    // NB: --list-sessions/--delete-session are flags of the `chat` subcommand
    // (verified against kiro-cli 2.12.1 — the top-level spelling is rejected
    // with "may be valid in newer versions").
    const raw = await kiroCapture(defaultIo, ["chat", "--list-sessions", "--format", "json"], cwd);
    try {
      const parsed = JSON.parse(stripVTControlCharacters(raw).trim());
      return Array.isArray(parsed) ? (parsed as KiroSessionListing[]) : [];
    } catch {
      return [];
    }
  },
  async deleteSession(sessionId) {
    await kiroCapture(defaultIo, ["chat", "--delete-session", sessionId], process.cwd());
  },
};

/**
 * The kiro-cli backend as an {@link AgentRunner}. A single per-*run* scratch cwd
 * is created lazily on first use and reused by every stage call (unique per run
 * ⇒ per-cwd listing isolation), then removed when the process exits.
 * Session-store cleanup happens ONCE per run via `finalize` — after all
 * concurrent workers join — under the deletion-scope invariant.
 */
export function makeKiroRunner(env: KiroEnv = defaultKiroEnv, scratchBase?: string): AgentRunner {
  let scratch: string | null = null;
  const cost: KiroCost = { credits: 0 };
  const ensureScratch = (): string => {
    if (scratch === null) {
      scratch = env.makeScratch(scratchBase);
      // Best-effort remove the scratch dir on process exit (auto-saved sessions
      // are cleaned by finalize under the scope invariant; this just tidies the
      // local agent-config dir, never corpus safety).
      const dir = scratch;
      process.once("exit", () => env.removeScratch(dir));
    }
    return scratch;
  };
  return {
    name: "kiro",
    installHint: KIRO_INSTALL_HINT,
    run: (opts) => runKiro(opts, ensureScratch(), env, cost),
    costSummary: () =>
      cost.credits > 0 ? `≈ ${cost.credits.toFixed(2)} Kiro credits used this run` : undefined,
    finalize: async () => {
      if (scratch !== null) await cleanupScratchSessions(scratch, env);
    },
  };
}

/** The default kiro runner (real environment). */
export const kiroRunner: AgentRunner = makeKiroRunner();
