import type { Drop, ExtractedMessage, ExtractResult, TimelineEvent } from "../types.js";
import type { KiroSessionMeta } from "./discover.js";
import {
  KIRO_AUTOMATION_FIRST_LINES,
  KIRO_DISTILL_SENTINEL,
  KIRO_HARNESS_NUDGES,
} from "./extract.js";

/**
 * sources/kiro/extract-v3.ts: the kiro-cli v3 ("Sol" harness) extractor.
 *
 * v3's `messages.jsonl` is one `{id, timestamp, payload}` JSON object per line;
 * `payload.type` discriminates. Only `user` entries carry the human's verbatim
 * text; `assistant` entries are the machine side (`operationType` "Say" is spoken
 * dialogue, "Reasoning" is internal thinking). Everything else (`tool_call`,
 * `tool_result`, `turn_start`/`turn_end`, `usage_summary`, `session_metadata`,
 * `session_event`, `session_start`, `steering_inclusion`, `sub_agent_*`) is
 * machine bookkeeping.
 *
 * Contrast the v2 extractor (extract.ts): v2 lines are `{version, kind, data}`
 * with `Prompt`/`AssistantMessage`/`ToolResults`, unix-seconds timestamps, and
 * `Prompt.data.content[]` text blocks that need per-piece machine-marker drops
 * (K6) and live-steering recovery (K14). v3 is simpler: `user.content` is a
 * single verbatim string, the timestamp is ISO-8601 in-band, and mid-run
 * steering arrives as an ordinary `user` entry (no envelope). So the per-piece
 * K6/K14 machinery does not apply; the only extraction drop is an empty body.
 *
 * As everywhere, parsing is tolerant: unknown `payload.type`s and fields are
 * ignored, and a corrupt line is counted in `badLines` rather than aborting.
 * The session-level human-vs-automation gate is {@link classifyKiroV3Session}.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and cap at 120 chars for a Drop snippet. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** The payload of one v3 line, or undefined when the line is not a v3 record. */
function payloadOf(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const p = parsed.payload;
  return isRecord(p) ? p : undefined;
}

/**
 * Detect whether a session's lines are the v3 store format. A v3 line is a
 * record with a `payload` object; a v2 line has top-level `kind`/`data` and no
 * `payload`. Decided on the FIRST parseable line (the stores never interleave),
 * defaulting to v2 when nothing parses (harmless: the v2 extractor is equally
 * tolerant of an empty/corrupt file).
 */
export function detectKiroFormat(lines: string[]): "v2" | "v3" {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    return isRecord(parsed.payload) ? "v3" : "v2";
  }
  return "v2";
}

/** The verbatim human text of a `user` entry, or null when its body is empty. */
function userText(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (typeof content !== "string") return null;
  const text = content.trim();
  return text === "" ? null : text;
}

/** The spoken text of an `assistant` `Say` entry (buffered as one timeline turn). */
function assistantSay(payload: Record<string, unknown>): string {
  if (payload.operationType !== "Say") return "";
  return typeof payload.content === "string" ? payload.content.trim() : "";
}

/**
 * Extract human-authored messages from one v3 session's raw JSONL lines. Only
 * `user` entries are candidates; an empty body is recorded as an observable Drop
 * (fidelity contract) rather than vanishing. Timestamps are the line's in-band
 * ISO-8601 `timestamp` ("" when absent, tolerated as on the v2 path).
 */
export function extractKiroV3Messages(lines: string[]): ExtractResult {
  const messages: ExtractedMessage[] = [];
  const drops: Drop[] = [];
  let badLines = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    const payload = payloadOf(parsed);
    if (payload === undefined || payload.type !== "user") continue;

    const ts = isRecord(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    const text = userText(payload);
    if (text === null) {
      const raw = typeof payload.content === "string" ? payload.content : "";
      drops.push({
        reason: "V3: empty user content",
        snippet: snippet(raw),
        timestamp: ts || undefined,
      });
      continue;
    }
    messages.push({ timestamp: ts, text });
  }

  return { messages, drops, badLines };
}

/**
 * Build a v3 session's linear timeline: `human` turns from `user` entries (via
 * the SAME {@link userText} the exporter uses, so human turns align 1:1 with the
 * corpus, the SessionSource law), and `assistant` turns from `Say` entries.
 * `Reasoning` is omitted (parity with the v2 timeline skipping thinking blocks).
 *
 * No `boundary` event is emitted: no compaction/clear entry has been observed in
 * the v3 store. If kiro adds one, extend this with a fixture first rather than
 * guessing its shape.
 */
export function kiroV3Timeline(lines: string[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = payloadOf(parsed);
    if (!payload) continue;
    const ts = isRecord(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    if (payload.type === "user") {
      const text = userText(payload);
      if (text !== null) events.push({ kind: "human", timestamp: ts, text });
    } else if (payload.type === "assistant") {
      const text = assistantSay(payload);
      if (text !== "") events.push({ kind: "assistant", timestamp: ts, text });
    }
  }
  return events;
}

/** First non-empty `user` text of a v3 session, for the automation-marker checks. */
function firstUserPromptV3(lines: string[]): string | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = payloadOf(parsed);
    if (payload === undefined || payload.type !== "user") continue;
    const text = userText(payload);
    if (text !== null) return text;
  }
  return null;
}

/**
 * V3 session-level human-vs-automation classification, recall-oriented, mirroring
 * the v2 K2 precedence with v3-appropriate signals:
 *
 *   1. first user prompt begins with the cc-hindsight distill sentinel → EXCLUDE
 *      (self-recognition, absolute; see K13);
 *   2. a `.history` companion exists (a human typed here) → INCLUDE;
 *   3. first user prompt is an automation marker (`[AGENT SYSTEM PROMPT]`, an
 *      automation-agent boilerplate first line, or a lone harness nudge) → EXCLUDE;
 *   4. else INCLUDE (recall-oriented default).
 *
 * Unlike v2, `parentSessionId` is NOT an exclusion signal: a top-level v3 session
 * dir with a parent link is a human FORK, and true subagents live under
 * `sub-executions/` and are never enumerated as sessions.
 */
export function classifyKiroV3Session(
  meta: KiroSessionMeta,
  firstPrompt: string | null,
): { include: boolean; reason: string } {
  if (firstPrompt?.startsWith(KIRO_DISTILL_SENTINEL)) {
    return { include: false, reason: "K13: cc-hindsight distill session (self-recognition)" };
  }
  if (meta.hasHistory) {
    return { include: true, reason: "V3: .history present (human typed here)" };
  }
  if (firstPrompt) {
    if (firstPrompt.startsWith("[AGENT SYSTEM PROMPT]")) {
      return { include: false, reason: "V3: [AGENT SYSTEM PROMPT] first prompt" };
    }
    if (KIRO_AUTOMATION_FIRST_LINES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "V3: automation-agent boilerplate first prompt" };
    }
    if (KIRO_HARNESS_NUDGES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "V3: harness-nudge-only session" };
    }
  }
  return { include: true, reason: "V3: recall-oriented default (no automation markers)" };
}

/** Classify from raw lines (reads the first user prompt itself). */
export function classifyKiroV3Lines(
  meta: KiroSessionMeta,
  lines: string[],
): { include: boolean; reason: string } {
  return classifyKiroV3Session(meta, firstUserPromptV3(lines));
}
