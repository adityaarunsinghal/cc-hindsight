import type { Drop, ExtractedMessage, ExtractResult, TimelineEvent } from "../types.js";
import type { KiroSessionMeta } from "./discover.js";

/**
 * sources/kiro/extract.ts — the kiro-cli extractor (rules K1–K13).
 *
 * kiro's v2 log is one `{version, kind, data}` JSON object per line. Only
 * `Prompt` entries carry the human's verbatim text; `AssistantMessage` and
 * `ToolResults` are the machine side. Unlike Claude Code there is no per-entry
 * human/automation flag — that decision is SESSION-level (see {@link classifyKiroSession},
 * K2), driven by store metadata (`.history` presence, `parent_session_id`, and
 * automation-marker first prompts). This module handles the per-piece rules and
 * the timeline; the session gate runs first, in the source's `classify`.
 *
 * As with the Claude extractor, parsing is tolerant: unknown `kind`s and fields
 * are ignored, and corrupt lines are counted in `badLines` rather than aborting.
 */

// --- K-rule constants ------------------------------------------------------

/**
 * K13 — self-recognition sentinel. cc-hindsight's own distill runner spawns
 * kiro sessions whose prompt begins with this marker; every headless run
 * persists a session in the flat store, so extraction must reject them or the
 * corpus would ingest its own distillation prompts on the next export.
 */
export const KIRO_DISTILL_SENTINEL = "[cc-hindsight distill]";

/** K6 — bracketed machine-injection markers dropped wherever they lead a piece. */
const BRACKET_MARKERS: readonly string[] = [
  "[AGENT SYSTEM PROMPT]",
  "[Recent channel messages for context:]",
  "[Subagent completion event]",
];

/**
 * K6 / K2 — harness nudge strings. As a leading substring they mark a
 * machine-injected retry prompt (drop the piece); as a whole-session's only
 * "human-looking" prompt they are the sole false-positive class the `.history`
 * signal misses (so classify filters them too).
 */
export const KIRO_HARNESS_NUDGES: readonly string[] = [
  "The generated tool was too large",
  "You took too long to respond",
  "You have not called the summary tool yet",
];

/**
 * K2 — automation-agent boilerplate first lines. A session whose first prompt
 * begins with one of these is a machine harness (naming/consolidation/suggestion
 * agents), not a human — excluded at the session level.
 */
export const KIRO_AUTOMATION_FIRST_LINES: readonly string[] = [
  "You are a session naming agent",
  "You are a memory consolidation agent",
  "You are generating contextual prompt suggestions",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and cap at 120 chars for a Drop snippet. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** Normalize kiro's unix-seconds timestamp into an ISO-8601 UTC string. */
function normalizeTimestamp(meta: unknown): string {
  if (!isRecord(meta)) return "";
  const ts = meta.timestamp;
  // kiro records unix SECONDS as an int; missing on ~30/410 prompts (tolerated).
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  return new Date(ts * 1000).toISOString();
}

/**
 * K1/K4/K6 — collect the surviving human pieces of ONE `Prompt` entry.
 *
 * `Prompt.data.content[]` items are `{kind:"text", data:<string>}` (K4). Each
 * text piece is cleaned per K6: drop empties; drop pieces whose first char is
 * `<` (e.g. `<agent-sop>` machine framing); drop bracket markers; drop harness
 * nudges. `meta.additionalContext` is NEVER read (always machine-injected
 * context, verified never to contain the human's own message). Returns the
 * joined text (blank-line separated) or null when nothing human survived.
 *
 * Shared by {@link extractKiroMessages} and {@link kiroTimeline} so the two
 * paths produce byte-identical human text (the SessionSource law).
 */
function promptText(data: unknown, drops: Drop[], ts: string): string | null {
  if (!isRecord(data)) return null;
  const content = data.content;
  if (!Array.isArray(content)) return null;

  const pieces: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.kind !== "text") continue; // K4 — only text blocks are candidate human input
    const raw = typeof block.data === "string" ? block.data : "";
    const text = raw.trim();
    if (text === "") {
      drops.push({ reason: "K6: empty piece", snippet: snippet(raw), timestamp: ts || undefined });
      continue;
    }
    if (text.startsWith("<")) {
      drops.push({
        reason: "K6: machine block (leading <)",
        snippet: snippet(text),
        timestamp: ts || undefined,
      });
      continue;
    }
    if (BRACKET_MARKERS.some((m) => text.startsWith(m))) {
      drops.push({
        reason: "K6: bracket marker",
        snippet: snippet(text),
        timestamp: ts || undefined,
      });
      continue;
    }
    if (KIRO_HARNESS_NUDGES.some((m) => text.startsWith(m))) {
      drops.push({
        reason: "K6: harness nudge",
        snippet: snippet(text),
        timestamp: ts || undefined,
      });
      continue;
    }
    pieces.push(text);
  }
  return pieces.length > 0 ? pieces.join("\n\n") : null;
}

/** Buffer an `AssistantMessage`'s text blocks into one assistant timeline event. */
function assistantText(data: unknown): string {
  if (!isRecord(data)) return "";
  const content = data.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    // toolUse / thinking blocks are skipped — only assistant prose is an
    // antecedent candidate (mirrors the Claude timeline's text-only buffer).
    if (block.kind === "text" && typeof block.data === "string") parts.push(block.data);
  }
  return parts.join("\n").trim();
}

/**
 * Extract human-authored messages from one kiro session's raw JSONL lines.
 *
 * K1: only `Prompt` entries are candidates. K12: `Clear`/`Compaction`/
 * `AssistantMessage`/`ToolResults` are never human text — `Compaction`'s
 * `messages_snapshot` duplicates same-file entries and must be ignored (not
 * deduped). Timestamps come only from `Prompt.meta.timestamp` (normalized to
 * ISO); missing → "" (tolerated exactly like the Claude path).
 */
export function extractKiroMessages(lines: string[]): ExtractResult {
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
    if (!isRecord(parsed)) {
      badLines++;
      continue;
    }

    // K1 — only Prompt entries are candidate human input.
    if (parsed.kind !== "Prompt") continue;

    const data = parsed.data;
    const ts = normalizeTimestamp(isRecord(data) ? data.meta : undefined);
    const text = promptText(data, drops, ts);
    if (text !== null) messages.push({ timestamp: ts, text });
  }

  return { messages, drops, badLines };
}

/**
 * Build a kiro session's linear timeline: `human` turns from `Prompt` text (via
 * the SAME {@link promptText} the exporter uses — so human turns align 1:1 with
 * the corpus), `assistant` turns from `AssistantMessage` text, and `boundary`
 * events for `Clear`/`Compaction` (a `/clear` or `/compact` is a hard context
 * reset — an antecedent must not resolve across it). There is no kiro
 * equivalent of ExitPlanMode / AskUserQuestion, so no `plan`/`question` events.
 */
export function kiroTimeline(lines: string[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const scratchDrops: Drop[] = []; // timeline callers do not consume drops.

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const kind = parsed.kind;
    const data = parsed.data;
    if (kind === "Prompt") {
      const ts = normalizeTimestamp(isRecord(data) ? data.meta : undefined);
      const text = promptText(data, scratchDrops, ts);
      if (text !== null) events.push({ kind: "human", timestamp: ts, text });
    } else if (kind === "AssistantMessage") {
      const text = assistantText(data);
      if (text !== "") events.push({ kind: "assistant", timestamp: "", text });
    } else if (kind === "Clear" || kind === "Compaction") {
      // Hard context reset — closes antecedent/decision windows (K12).
      events.push({ kind: "boundary", timestamp: "", text: kind });
    }
    // ToolResults and unknown kinds are not timeline events.
  }

  return events;
}

/** First non-empty `Prompt` text of a session, for K2 automation-marker checks. */
function firstPromptText(lines: string[]): string | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.kind !== "Prompt") continue;
    const data = parsed.data;
    if (!isRecord(data) || !Array.isArray(data.content)) continue;
    for (const block of data.content) {
      if (isRecord(block) && block.kind === "text" && typeof block.data === "string") {
        const t = block.data.trim();
        if (t !== "") return t;
      }
    }
  }
  return null;
}

/**
 * K2 — session-level human-vs-automation classification, with EXPLICIT
 * precedence (recall-oriented: a real human session must never be dropped):
 *
 *   1. `.history` exists → INCLUDE. A human typed here; this overrides every
 *      exclusion below and covers HYBRID sessions (agent-spawned or rewind
 *      children a human later steered).
 *   2. else `parent_session_id` set → EXCLUDE (a spawned child with no human).
 *   3. else the first Prompt is an automation marker — `[AGENT SYSTEM PROMPT]`,
 *      an automation-agent boilerplate first line, or a lone harness nudge →
 *      EXCLUDE.
 *   4. else INCLUDE (recall-oriented default).
 *
 * `session_created_reason` is deliberately NOT used — it reports "subagent"
 * even for interactive human sessions (verified on-machine).
 *
 * K13 — a session whose first prompt is cc-hindsight's own distill sentinel is
 * always excluded (self-recognition), regardless of the above.
 */
export function classifyKiroSession(
  meta: KiroSessionMeta,
  firstPrompt: string | null,
): { include: boolean; reason: string } {
  if (firstPrompt?.startsWith(KIRO_DISTILL_SENTINEL)) {
    return { include: false, reason: "K13: cc-hindsight distill session (self-recognition)" };
  }
  if (meta.hasHistory) {
    return { include: true, reason: "K2: .history present (human typed here)" };
  }
  if (meta.parentSessionId) {
    return { include: false, reason: "K2: spawned child (parent_session_id set, no .history)" };
  }
  if (firstPrompt) {
    if (firstPrompt.startsWith("[AGENT SYSTEM PROMPT]")) {
      return { include: false, reason: "K2: [AGENT SYSTEM PROMPT] first prompt" };
    }
    if (KIRO_AUTOMATION_FIRST_LINES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "K2: automation-agent boilerplate first prompt" };
    }
    if (KIRO_HARNESS_NUDGES.some((m) => firstPrompt.startsWith(m))) {
      return { include: false, reason: "K2: harness-nudge-only session" };
    }
  }
  return { include: true, reason: "K2: recall-oriented default (no automation markers)" };
}

/** Classify from raw lines (reads the first prompt itself). */
export function classifyKiroLines(
  meta: KiroSessionMeta,
  lines: string[],
): { include: boolean; reason: string } {
  return classifyKiroSession(meta, firstPromptText(lines));
}
