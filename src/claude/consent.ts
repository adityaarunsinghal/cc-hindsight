import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { bold, cyan, dim, yellow } from "../ui/style.js";

/**
 * The consent & cost gate (§5.7).
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
  /** Optional resume line shown when checkpoints already exist. */
  resumeNote?: string;
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
 * Render the disclosure block exactly as specified in §5.7: a two-space-indented
 * header, a bulleted breakdown with right-aligned counts (the author line
 * carries a `~` prefix), and the `≈ total` summary. The trailing `Proceed?`
 * prompt is intentionally *not* part of this block — dry-run prints the block
 * but must not prompt.
 */
export function renderPlan(plan: DistillPlan): string {
  const digestStr = String(plan.digests);
  const clusterStr = String(plan.cluster);
  const authorStr = `~${plan.authorEstimate}`;
  const width = Math.max(digestStr.length, clusterStr.length, authorStr.length);

  const total = plan.digests + plan.cluster + plan.authorEstimate;
  const count = (s: string) => bold(cyan(s.padStart(width)));

  const lines = [
    "  distill will invoke your local `claude` CLI (your subscription/credits):",
    `    ${dim("•")} ${count(digestStr)} session digests`,
    `    ${dim("•")} ${count(clusterStr)} clustering call`,
    `    ${dim("•")} ${count(authorStr)} oneshot authoring calls (one per task; exact count known after clustering)`,
    `  ≈ ${bold(cyan(String(total)))} invocations total.${dim(" Nothing is sent anywhere except through your own claude CLI.")}`,
  ];
  if (plan.resumeNote) {
    lines.push(`  ${yellow(plan.resumeNote)}`);
  }
  return lines.join("\n");
}

function ask(question: string, input: Readable, output: Writable): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Generic `[y/N]` confirmation on injected streams (default No). Used for
 * secondary gates like `distill --fresh` (§5.7: checkpoints are cleared only
 * after an explicit confirmation).
 */
export async function askYesNo(
  question: string,
  opts: { input?: Readable; output?: Writable } = {},
): Promise<boolean> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const answer = await ask(`${question} [y/N] `, input, output);
  const norm = answer.trim().toLowerCase();
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
