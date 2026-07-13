/**
 * core/anaphora.ts — the recall-oriented anaphora pass.
 *
 * For EVERY short human turn (≤ {@link SHORT_TURN_MAX_WORDS} whitespace tokens)
 * we attach the context needed to later resolve what "yes", "do both", or
 * "option 2" meant, WITHOUT classifying which turns are actually referential —
 * false positives are free, false negatives are the failure mode. Two
 * kinds of context are attached, either/both/neither may be present:
 *
 *   (a) antecedent — the ~{@link TAIL_CHARS}-char TAIL of the immediately
 *       preceding assistant *text* turn ("the ask lives at the end of an
 *       essay", so we keep the end, not the head);
 *   (b) a pending decision surface — the most recent `ExitPlanMode` plan or
 *       `AskUserQuestion` question issued by the assistant AFTER the previous
 *       human turn and BEFORE this one; i.e. exactly what a bare "yes" approved.
 *
 * Index alignment is sacred: every record's `index` is the POST-DEDUPE
 * message index from {@link buildCorpus} — the position of that message in the
 * rendered export. Human turns that were dropped as fork copies (owned by an
 * earlier session, rule R8) get NO record here; they are recorded where they
 * are owned. Attached assistant text is consumed ONLY to resolve meaning and
 * is never copied into a oneshot.
 *
 * KNOWN v1 LIMITATION: antecedent/decision selection is a linear
 * file-order scan. On forked or regenerated conversations (multiple assistant
 * branches interleaved by timestamp) it can pick the wrong branch. parentUuid
 * walking is the planned v1.1 fix; see the TODO-marked test in
 * test/anaphora.test.ts.
 */

import type { CorpusSession } from "./dedupe.js";
import { extractTimeline, type TimelineEvent } from "./extract.js";

/** Human turns with at most this many whitespace tokens get a record. */
export const SHORT_TURN_MAX_WORDS = 15;

/** Antecedent / assistant-tail bound; the tail is kept, the head is dropped. */
export const TAIL_CHARS = 1600;

/** The kind of pending decision surface a short turn responded to. */
export type DecisionKind = "plan" | "question";

/**
 * One attached short human turn. Written to `exports/anaphora.json` under the
 * export file name (see {@link buildAnaphora}). `antecedent`/`decision_*` are
 * null when absent (e.g. the session's first message has neither).
 */
export interface AnaphoraRecord {
  /** POST-DEDUPE message index — aligns with the rendered export heading. */
  index: number;
  timestamp: string;
  human_text: string;
  antecedent: string | null;
  decision_kind: DecisionKind | null;
  decision_text: string | null;
}

/** Whitespace-split token count (word = whitespace-delimited run). */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** True when a human turn is short enough to attach context to (recall-oriented). */
export function isShortTurn(text: string): boolean {
  return wordCount(text) <= SHORT_TURN_MAX_WORDS;
}

/** Keep the last {@link TAIL_CHARS} characters of a string (its tail). */
function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

/** The `(timestamp, text)` dedupe key — must match core/dedupe.ts exactly. */
function messageKey(timestamp: string, text: string): string {
  return `${timestamp}\u0000${text}`;
}

/**
 * The immediately preceding assistant *text* turn's tail, scanning backward
 * from `humanPos`. Skips `plan`/`question` events (they are surfaced as the
 * decision, not the antecedent) and, by construction, never sees sidechain
 * assistant turns (excluded by {@link extractTimeline}'s R2 pass). Returns null
 * when no assistant text turn precedes this human turn.
 */
function findAntecedent(timeline: TimelineEvent[], humanPos: number): string | null {
  for (let j = humanPos - 1; j >= 0; j--) {
    const event = timeline[j];
    if (event?.kind === "assistant") return tail(event.text);
  }
  return null;
}

/**
 * The pending decision surface: the most recent `plan`/`question` event strictly
 * between the previous human turn (`prevHumanPos`, exclusive) and this one
 * (`humanPos`, exclusive). Scanning backward returns the closest-to-now match, so
 * a plan issued BEFORE the previous human turn is correctly NOT pending here.
 */
function findDecision(
  timeline: TimelineEvent[],
  prevHumanPos: number,
  humanPos: number,
): { kind: DecisionKind; text: string } | null {
  for (let j = humanPos - 1; j > prevHumanPos; j--) {
    const event = timeline[j];
    if (event?.kind === "plan") return { kind: "plan", text: event.text };
    if (event?.kind === "question") return { kind: "question", text: event.text };
  }
  return null;
}

/**
 * Build the anaphora records for ONE deduped session, aligned to its
 * post-dedupe indices.
 *
 * `session` supplies the surviving (owned) messages and their alignment indices;
 * `lines` are that session file's raw JSONL, walked once into a timeline so the
 * antecedent and decision windows see the full conversation (assistant turns,
 * plans, questions, and even fork-copied human turns) — while records are only
 * emitted for short human turns THIS session owns.
 */
export function buildAnaphora(session: CorpusSession, lines: string[]): AnaphoraRecord[] {
  const timeline = extractTimeline(lines);

  // Owned (survived dedupe here) key → post-dedupe index. First occurrence wins,
  // matching dedupe's keep-the-first-in-file-order behavior.
  const ownedIndex = new Map<string, number>();
  for (const message of session.messages) {
    const key = messageKey(message.timestamp, message.text);
    if (!ownedIndex.has(key)) ownedIndex.set(key, message.index);
  }

  const records: AnaphoraRecord[] = [];
  const emitted = new Set<number>();
  let prevHumanPos = -1;

  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i];
    if (event?.kind !== "human") continue;

    if (isShortTurn(event.text)) {
      const index = ownedIndex.get(messageKey(event.timestamp, event.text));
      // Emit only for short turns THIS session owns (fork copies are recorded
      // where they are owned), each index at most once.
      if (index !== undefined && !emitted.has(index)) {
        emitted.add(index);
        const decision = findDecision(timeline, prevHumanPos, i);
        records.push({
          index,
          timestamp: event.timestamp,
          human_text: event.text,
          antecedent: findAntecedent(timeline, i),
          decision_kind: decision?.kind ?? null,
          decision_text: decision?.text ?? null,
        });
      }
    }
    prevHumanPos = i;
  }

  // Deterministic, render-aligned order.
  records.sort((a, b) => a.index - b.index);
  return records;
}
