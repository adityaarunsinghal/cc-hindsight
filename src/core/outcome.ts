/**
 * core/outcome.ts — bounded outcome-evidence pass (PLAN §5.5, F11, flaw 1).
 *
 * Without any signal of whether a session succeeded, failed, or was abandoned,
 * the distill stages would confidently author "ideal" prompts that reproduce
 * failure paths. This deterministic pass captures a SMALL, clearly-labeled slice
 * of outcome evidence per session for the digest stage to classify:
 *
 *   - final_human_turns:    the last {@link FINAL_TURNS} deduped human turns,
 *                           most recent LAST (what the human ended up asking for);
 *   - final_assistant_tail: the ~{@link TAIL_CHARS}-char tail of the LAST
 *                           assistant text turn in the file ("" if none).
 *
 * This is distill INPUT ONLY — the human-only export artifact is unaffected. The
 * assistant text is machine-authored and is never copied into a oneshot; the
 * `_note` written alongside the data (see the export command) states this per
 * F11/§5.5.
 */

import { TAIL_CHARS } from "./anaphora.js";
import type { CorpusSession } from "./dedupe.js";
import { extractTimeline } from "./extract.js";

// TAIL_CHARS originates with the anaphora tail bound; re-export it so outcome
// tests can import the single source of truth from here too.
export { TAIL_CHARS };

/** How many trailing human turns to capture as outcome evidence. */
export const FINAL_TURNS = 3;

/**
 * A top-level `_note` for `outcomes.json` labeling the assistant text as
 * machine-authored context (F11/§5.5) — it is never surfaced in an export or a
 * oneshot, only fed to the outcome-classification stage of distill.
 */
export const OUTCOME_NOTE =
  "final_assistant_tail is machine-authored assistant text, captured as bounded " +
  "outcome evidence for distillation only; it is never copied into an export or a oneshot.";

/** Bounded, labeled outcome evidence for one session (written to outcomes.json). */
export interface OutcomeEvidence {
  /** Last {@link FINAL_TURNS} deduped human turns, chronological (most recent last). */
  final_human_turns: string[];
  /** Tail of the last assistant text turn in the file; "" when there is none. */
  final_assistant_tail: string;
}

/**
 * Capture bounded outcome evidence for ONE deduped session.
 *
 * `final_human_turns` come from the session's post-dedupe survivors (so they are
 * exactly what the export shows); `final_assistant_tail` is recovered from the
 * raw timeline (assistant text is not part of the export corpus). Both are
 * bounded: at most {@link FINAL_TURNS} human turns and {@link TAIL_CHARS} chars.
 */
export function buildOutcome(session: CorpusSession, lines: string[]): OutcomeEvidence {
  const final_human_turns = session.messages.slice(-FINAL_TURNS).map((message) => message.text);

  let final_assistant_tail = "";
  const timeline = extractTimeline(lines);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i];
    if (event?.kind === "assistant") {
      final_assistant_tail =
        event.text.length > TAIL_CHARS ? event.text.slice(-TAIL_CHARS) : event.text;
      break;
    }
  }

  return { final_human_turns, final_assistant_tail };
}
