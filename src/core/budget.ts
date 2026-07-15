/**
 * core/budget.ts — input budgeting & overflow policy.
 *
 * Session content is inlined into distill prompts verbatim, bounded by a
 * budget derived from real model capacity — and an explicit overflow policy
 * guarantees nothing is EVER cut silently:
 *
 *   - The budget defaults to ~400k chars (~100k tokens at ~4 chars/token, ample
 *     headroom under a 200k-token context) and is overridable with
 *     `--input-budget`.
 *   - When a unit (a session's content, or a task's aggregate member content)
 *     exceeds the budget, the `--truncate` policy decides:
 *       · "never" (default) — BLOCK the unit; it is reported and skipped, never
 *         cut. No silent data loss; the user is told and can raise the budget,
 *         narrow scope, or opt into cutting.
 *       · "extreme" — middle-cut the unit to the budget (head+tail kept), and
 *         record the exact cut for disclosure (consent plan, `sources.json`
 *         provenance, `show` coverage badge).
 *
 * Lossless chunking — splitting oversized work into MORE calls rather than
 * cutting — is a roadmap item; until it lands, "never" is the honest default
 * and "extreme" is the disclosed escape hatch.
 *
 * Pure module: no filesystem, no model — every decision is a function of byte
 * counts and flags, so the whole plan is deterministic and unit-testable.
 */

/** Default input budget in characters (~100k tokens with headroom). */
export const DEFAULT_INPUT_BUDGET = 400_000;

/** Floor for `--input-budget`; smaller values are ignored in favor of the default. */
export const MIN_INPUT_BUDGET = 1_000;

/** How to handle a unit that exceeds the budget. */
export type TruncatePolicy = "never" | "extreme";

/** Resolve `--input-budget` (chars). Invalid / sub-floor values → default. */
export function resolveInputBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INPUT_BUDGET;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < MIN_INPUT_BUDGET) return DEFAULT_INPUT_BUDGET;
  return n;
}

/** Resolve `--truncate`; anything other than "extreme" is the safe "never". */
export function resolveTruncatePolicy(raw: string | undefined): TruncatePolicy {
  return raw === "extreme" ? "extreme" : "never";
}

/** Resolve `--timeout` (seconds) to milliseconds; invalid/absent → undefined (runner default). */
export function resolveTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isNaN(seconds) || seconds <= 0) return undefined;
  return seconds * 1_000;
}

/** The inline truncation note (also seen by the model). Kept stable for tests. */
export function truncationNote(dropped: number): string {
  return `\n\n[... cc-hindsight truncated ${dropped} characters from the middle of this session ...]\n\n`;
}

/**
 * Middle-cut `content` to at most `budget` characters, keeping the head and the
 * tail (goal at the start, resolution at the end) with a truncation note in
 * between whose stated dropped-count is EXACT (fixed-point settled — the note's
 * length varies with the count's digits). Returns the cut text and the exact
 * number of characters dropped (0 when it already fits).
 */
export function middleCut(content: string, budget: number): { text: string; dropped: number } {
  if (content.length <= budget) return { text: content, dropped: 0 };

  // Settle `keep` (kept content chars) so `note(dropped)` reports the truth.
  let keep = budget - truncationNote(content.length - budget).length;
  for (let i = 0; i < 5; i++) {
    const settled = budget - truncationNote(content.length - keep).length;
    if (settled === keep) break;
    keep = settled;
  }

  // Degenerate: budget smaller than the note. Return a bounded note only.
  if (keep <= 0) {
    return { text: truncationNote(content.length).slice(0, budget), dropped: content.length };
  }

  const dropped = content.length - keep;
  const marker = truncationNote(dropped);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return { text: content.slice(0, head) + marker + content.slice(content.length - tail), dropped };
}
