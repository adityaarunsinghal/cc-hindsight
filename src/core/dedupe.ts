/**
 * core/dedupe.ts — R8 global cross-file dedupe (PLAN §5.4, flaw 7 in §4.2).
 *
 * THE SINGLE SOURCE OF TRUTH for the deduped corpus. Export, and (in Task 5)
 * the anaphora and outcome-evidence passes, all consume ONE `buildCorpus` pass
 * so the per-session message `index` aligns exactly with the exported markdown
 * — no O(N²) re-export per alignment (§5.5, first paragraph).
 *
 * Why dedupe at all: Claude Code copies prior history into a NEW session file
 * on fork/resume, so the same (timestamp, text) human message appears in
 * multiple transcripts. Attributing each key to the earliest session keeps
 * evidence from being double-counted. Timestamp keying is deliberate:
 * fork-copies carry IDENTICAL timestamps (they are literal copies), whereas a
 * human deliberately re-sending the same text does so at a NEW timestamp — so
 * a different key — and therefore survives in both sessions.
 *
 * Pure module: no filesystem access. Input is the raw JSONL lines of each
 * session (already discovered by core/discover.ts); output is the deduped
 * corpus. Extraction (R1–R7, R10, R11) is delegated to core/extract.ts.
 */

import { type Drop, type ExtractedMessage, extractMessages } from "./extract.js";

/** One session's raw input to the corpus builder. */
export interface DedupeInput {
  /** Project short name (from discover). Copied through to the corpus. */
  project: string;
  /** Session id — the transcript basename without `.jsonl`. */
  sessionId: string;
  /** Absolute (or resolved) path to the source `.jsonl`, for provenance. */
  sourcePath: string;
  /** Raw newline-delimited JSONL lines of the session file. */
  lines: string[];
}

/**
 * A surviving human message in the deduped corpus.
 *
 * `index` is the 0-based position within THIS session's surviving (post-dedupe)
 * messages. It is THE alignment key: the anaphora and outcome passes (Task 5)
 * reference messages by `index`, and render.ts emits them in `index` order, so
 * `anaphora.json` records line up byte-for-byte with the exported markdown.
 */
export interface DedupedMessage {
  index: number;
  timestamp: string;
  text: string;
}

/** One session as it appears in the corpus, after cross-file dedupe. */
export interface CorpusSession {
  project: string;
  sessionId: string;
  sourcePath: string;
  /** Ordered, post-dedupe surviving messages (may be empty → export skips it). */
  messages: DedupedMessage[];
  /** Every dropped piece/entry from extraction, for `--verbose` (flaw 6). */
  drops: Drop[];
  /** Corrupt/unparseable JSONL lines skipped during extraction. */
  badLines: number;
  /** Timestamp of the first surviving message ("" when none survive). */
  firstTs: string;
  /** Timestamp of the last surviving message ("" when none survive). */
  lastTs: string;
  /** How many of this session's extracted messages dropped as fork copies. */
  dedupeDropped: number;
}

/** The whole corpus plus run-level stats. */
export interface Corpus {
  /** Sessions in deterministic attribution order (see {@link buildCorpus}). */
  sessions: CorpusSession[];
  /** Total messages dropped as cross-file fork copies (sum of dedupeDropped). */
  duplicatesDropped: number;
}

/**
 * Dedupe key: `(timestamp, text)`. The NUL separator can never occur inside a
 * timestamp, so it unambiguously delimits the two fields.
 */
function dedupeKey(message: ExtractedMessage): string {
  return `${message.timestamp}\u0000${message.text}`;
}

/**
 * Earliest non-empty message timestamp of a session, used only to ORDER
 * sessions for attribution. Empty when the session has no timestamped
 * messages; such sessions sort first but contribute no owned keys, so ordering
 * among them is irrelevant to correctness. ISO-8601 UTC strings compare
 * lexicographically in chronological order.
 */
function earliestTimestamp(messages: ExtractedMessage[]): string {
  let earliest: string | undefined;
  for (const message of messages) {
    if (message.timestamp === "") continue;
    if (earliest === undefined || message.timestamp < earliest) earliest = message.timestamp;
  }
  return earliest ?? "";
}

/**
 * Build the deduped corpus (R8).
 *
 * Attribution rule (deterministic): sort sessions by earliest message
 * timestamp ascending, breaking ties on `sessionId` lexicographically; process
 * in that order; the FIRST session to contain a `(timestamp, text)` key OWNS
 * it, and every later occurrence is dropped as a fork copy. Because the sort is
 * a total order independent of input order, the result is stable under any
 * permutation of the input (asserted in test/dedupe.test.ts).
 *
 * A zero-surviving-message session stays in the corpus with an empty
 * `messages` array — export skips it naturally (R9), and Task 5 still records
 * that it was seen.
 */
export function buildCorpus(input: DedupeInput[]): Corpus {
  // Extract once per session, remembering each session's ordering timestamp.
  const extracted = input.map((session) => {
    const result = extractMessages(session.lines);
    return { session, result, earliest: earliestTimestamp(result.messages) };
  });

  // Total order for attribution: earliest timestamp, then sessionId.
  extracted.sort((a, b) => {
    if (a.earliest !== b.earliest) return a.earliest < b.earliest ? -1 : 1;
    if (a.session.sessionId !== b.session.sessionId) {
      return a.session.sessionId < b.session.sessionId ? -1 : 1;
    }
    return 0;
  });

  const seen = new Set<string>();
  const sessions: CorpusSession[] = [];
  let duplicatesDropped = 0;

  for (const { session, result } of extracted) {
    const messages: DedupedMessage[] = [];
    let dedupeDropped = 0;

    for (const message of result.messages) {
      const key = dedupeKey(message);
      if (seen.has(key)) {
        // Earlier session already owns this exact (timestamp, text): fork copy.
        dedupeDropped++;
        duplicatesDropped++;
        continue;
      }
      seen.add(key);
      // index = position among THIS session's survivors (the alignment key).
      messages.push({ index: messages.length, timestamp: message.timestamp, text: message.text });
    }

    sessions.push({
      project: session.project,
      sessionId: session.sessionId,
      sourcePath: session.sourcePath,
      messages,
      drops: result.drops,
      badLines: result.badLines,
      firstTs: messages[0]?.timestamp ?? "",
      lastTs: messages.at(-1)?.timestamp ?? "",
      dedupeDropped,
    });
  }

  return { sessions, duplicatesDropped };
}
