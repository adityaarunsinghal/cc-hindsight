import type { Writable } from "node:stream";
import { spinner } from "@clack/prompts";

/**
 * ui/progress.ts — a live elapsed-time spinner around each claude call.
 *
 * A distill call runs ~30–60s and used to render as pure silence, which reads
 * as a hang. On an interactive terminal, `withSpinner` shows a clack spinner
 * with a timer while `fn` is in flight and *clears it completely* afterwards —
 * the permanent, test-pinned log lines around it stay byte-identical in every
 * mode. Pipes, CI, and injected test sinks never see the spinner at all.
 */
export async function withSpinner<T>(
  out: Writable,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const interactive = out === process.stdout && process.stdout.isTTY === true;
  if (!interactive) return fn();

  const s = spinner({ indicator: "timer" });
  s.start(label);
  try {
    const result = await fn();
    s.clear();
    return result;
  } catch (err) {
    s.clear();
    throw err;
  }
}
