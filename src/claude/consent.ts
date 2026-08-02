import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { bold, cyan, dim, yellow } from "../ui/style.js";

/**
 * The consent & cost gate.
 *
 * Before distill invokes the local `claude` CLI it discloses the exact
 * invocation count and asks for confirmation. Nothing runs implicitly:
 *   - `--dry-run` prints the plan and never prompts.
 *   - `--yes` skips the prompt (for scripting) and never reads stdin.
 *   - Otherwise an interactive `[y/N]` prompt is shown; the default is No.
 */

/** The invocation plan disclosed to the user. */
export interface DistillPlan {
  /** Number of per-session digest calls. */
  digests: number;
  /** Whether a clustering call runs (0 with `--no-group`, else 1). */
  cluster: 0 | 1;
  /** Estimated authoring calls (one per task; exact count known post-cluster). */
  authorEstimate: number;
  /**
   * Which local CLI will be invoked ("claude" | "kiro"). Defaults to "claude"
   * so the disclosure copy is byte-identical to before when the resolved runner
   * is claude; a kiro runner names kiro (and its credits) instead.
   */
  runnerName?: "claude" | "kiro";
  /** Optional resume line shown when checkpoints already exist. */
  resumeNote?: string;
  /** Input budget in chars — when set, a coverage disclosure line is shown. */
  budget?: number;
  /** Overflow policy in effect. */
  truncate?: "never" | "extreme";
  /** Eligible sessions whose content exceeds the budget (consent-time estimate). */
  oversized?: { export: string; chars: number }[];
}

/** Human-facing CLI name + the cost noun, per runner (for consent copy). */
function runnerCopy(name: DistillPlan["runnerName"]): { cli: string; cost: string } {
  return name === "kiro"
    ? { cli: "kiro-cli", cost: "your Kiro credits" }
    : { cli: "claude", cost: "your subscription/credits" };
}

export interface ConsentOptions {
  /** Skip the prompt and proceed (still prints the plan). */
  yes?: boolean;
  /** Print the plan and exit without prompting or invoking anything. */
  dryRun?: boolean;
  /** Injected input stream (default process.stdin). */
  input?: Readable;
  /** Injected output stream (default process.stdout). */
  output?: Writable;
}

export type ConsentResult = "proceed" | "declined" | "dry-run";

/** The interactive prompt string (trailing space is conventional for readline). */
export const PROCEED_PROMPT = "  Proceed? [y/N] ";

/**
 * Render the disclosure block: a two-space-indented header, a bulleted
 * breakdown with right-aligned counts (the author line carries a `~` prefix),
 * and the `≈ total` summary. The exact copy is byte-pinned by tests — it is a
 * contract, not decoration. The trailing `Proceed?` prompt is intentionally
 * *not* part of this block — dry-run prints the block but must not prompt.
 */
export function renderPlan(plan: DistillPlan): string {
  const digestStr = String(plan.digests);
  const clusterStr = String(plan.cluster);
  const authorStr = `~${plan.authorEstimate}`;
  const width = Math.max(digestStr.length, clusterStr.length, authorStr.length);

  const total = plan.digests + plan.cluster + plan.authorEstimate;
  const count = (s: string) => bold(cyan(s.padStart(width)));
  const { cli, cost } = runnerCopy(plan.runnerName);

  const lines = [
    `  distill will invoke your local \`${cli}\` CLI (${cost}):`,
    `    ${dim("•")} ${count(digestStr)} session digests`,
    `    ${dim("•")} ${count(clusterStr)} clustering call`,
    `    ${dim("•")} ${count(authorStr)} oneshot authoring calls (one per task; exact count known after clustering)`,
    `  ≈ ${bold(cyan(String(total)))} invocations total.${dim(` Nothing is sent anywhere except through your own ${cli} CLI.`)}`,
  ];
  // Coverage disclosure: only shown when a budget context is supplied.
  // never-mode overflow is refused BEFORE consent (pre-spend), so the only case
  // reaching here with oversized sessions is extreme mode, which cuts + reports.
  if (plan.budget !== undefined) {
    const oversized = plan.oversized ?? [];
    if (oversized.length > 0 && plan.truncate === "extreme") {
      lines.push(
        `  ${yellow(`⚠ ${oversized.length} session(s) exceed the ${plan.budget}-char budget and will be cut middle-out (reported).`)}`,
      );
    } else if (oversized.length === 0) {
      lines.push(
        `  ${dim(`Every exported byte will reach the model (budget ${plan.budget} chars).`)}`,
      );
    }
  }
  if (plan.resumeNote) {
    lines.push(`  ${yellow(plan.resumeNote)}`);
  }
  return lines.join("\n");
}

function ask(question: string, input: Readable, output: Writable): Promise<string> {
  // An already-exhausted stream (e.g. a second prompt after `printf 'y\n' |`
  // fed the first) will never deliver a fresh line, and a new readline
  // interface over it won't emit its own `close` — the promise would hang
  // forever. Treat a spent stream as EOF (empty input) up front; callers map
  // that to the default answer. A live TTY reports readableEnded === false.
  if (input.readableEnded) return Promise.resolve("");

  // Tap the raw bytes BEFORE readline is constructed so this listener is first
  // in line and observes every chunk whatever readline does with it. This is the
  // only way to recover an answer that arrives WITHOUT a trailing newline:
  // readline discards such a final line rather than emitting it, so `printf y |`
  // (or Ctrl-D straight after the keystroke) would otherwise resolve to "" and
  // silently invert the user's answer to the default. Observed in the wild as
  // `Proceed? [y/N] ydeclined; nothing was invoked.` — the `y` echoed, then lost.
  let raw = "";
  const tap = (chunk: Buffer | string) => {
    raw += chunk.toString();
  };
  input.on("data", tap);

  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    let answered = false;
    const done = (answer: string) => {
      if (answered) return;
      answered = true;
      input.off("data", tap);
      rl.close();
      resolve(answer);
    };
    rl.question(question, done);
    // EOF (piped `< /dev/null`, CI, Ctrl-D) closes the stream WITHOUT firing the
    // question callback. Without this, the promise would never resolve — the
    // process hangs or falls off the event loop and exits 0 having done nothing,
    // violating the "declining is exit 2, never a partial run" contract. Fall
    // back to the FIRST line of the tapped bytes: that recovers a newline-less
    // answer, and is still "" for a genuine no-input EOF, which the callers map
    // to the default. Taking only the first line keeps later bytes (a second
    // queued answer) out of this one.
    rl.on("close", () => done(raw.split(/\r?\n/)[0] ?? ""));
  });
}

/**
 * Generic confirmation on injected streams. Default No (`[y/N]`) unless
 * `defaultYes` is set (`[Y/n]`), in which case empty input / EOF means yes.
 *
 * The destructive `--fresh` gate uses the default-No form (an unattended EOF
 * must never clear checkpoints). The seamless-flow offers (run export first?,
 * show the library?) use `defaultYes` — they're local, free, and reversible, so
 * the low-friction default serves the one-shot experience.
 */
export async function askYesNo(
  question: string,
  opts: { input?: Readable; output?: Writable; defaultYes?: boolean } = {},
): Promise<boolean> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const answer = await ask(`${question} ${opts.defaultYes ? "[Y/n]" : "[y/N]"} `, input, output);
  const norm = answer.trim().toLowerCase();
  if (norm === "") return opts.defaultYes === true; // empty / EOF → the default
  return norm === "y" || norm === "yes";
}

/**
 * Show the plan and obtain consent. Returns:
 *   - `dry-run` when `opts.dryRun` (plan printed, stdin never touched);
 *   - `proceed` when `opts.yes` (stdin never touched) or the user answers y/yes;
 *   - `declined` otherwise (default No on empty input).
 */
export async function confirm(plan: DistillPlan, opts: ConsentOptions): Promise<ConsentResult> {
  const output = opts.output ?? process.stdout;
  output.write(`${renderPlan(plan)}\n`);

  if (opts.dryRun) return "dry-run";
  if (opts.yes) return "proceed";

  const input = opts.input ?? process.stdin;
  const answer = await ask(PROCEED_PROMPT, input, output);
  const norm = answer.trim().toLowerCase();
  return norm === "y" || norm === "yes" ? "proceed" : "declined";
}
