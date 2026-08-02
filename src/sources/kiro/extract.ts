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
  "[LIVE STEERING - New message from user]",
];

/**
 * K14 — live-steering recovery. A message the human types WHILE the agent is
 * working arrives wrapped in a harness envelope, not as its own Prompt:
 *
 *   [LIVE STEERING - New message from user]
 *   The user sent a new message while you are working. …
 *   <user_message id="steer-…">
 *   the words the human actually typed
 *   </user_message>
 *   IMPORTANT: After completing your work, … [STEERING steer-…: …]
 *
 * The envelope leads with a bracket marker, so K6 would drop the whole thing and
 * the human's words with it. Recover the `<user_message>` body FIRST (the same
 * ordering trick R10 uses for slash-commands on the Claude side), and keep the
 * surrounding harness instructions out: they are machine text and would
 * otherwise dominate the digest prompt.
 *
 * These are the highest-value turns in a corpus, since steering is where the
 * human corrects course mid-run. Measured on a real 306-session store: 112
 * messages, ~13.6k chars.
 */
const LIVE_STEERING_MARKER = "[LIVE STEERING - New message from user]";
const USER_MESSAGE_RE = /<user_message\b[^>]*>([\s\S]*?)<\/user_message>/;

/** Pull the human words out of a live-steering envelope; null if there are none. */
function recoverSteeringText(text: string): string | null {
  if (!text.startsWith(LIVE_STEERING_MARKER)) return null;
  const body = USER_MESSAGE_RE.exec(text)?.[1]?.trim();
  return body ? body : null;
}

/**
 * K14 — steering messages recovered from a `ToolResults` entry.
 *
 * In real sessions the harness delivers a mid-run steering message by appending
 * it to the NEXT `ToolResults` entry's `content`, not as its own `Prompt`. Since
 * K1 only admits `Prompt`, all of them were invisible: on a real 306-session
 * store, 100 of the 112 steering messages arrive this way (12 more only in a
 * `Compaction` snapshot, which K12 already reports as a drop).
 *
 * Only `kind: "text"` blocks whose text opens with the steering marker are
 * admitted. That is deliberately narrow: the same content arrays hold 5630
 * `toolResult` blocks of pure machine output, and nothing else in a
 * `ToolResults` entry is human. Shared by extract and timeline so the
 * SessionSource law holds.
 */
function steeringFromToolResults(data: unknown): string[] {
  const content = isRecord(data) ? data.content : undefined;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.kind !== "text" || typeof block.data !== "string") continue;
    const recovered = recoverSteeringText(block.data.trim());
    if (recovered !== null) out.push(recovered);
  }
  return out;
}

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
    if (block.kind !== "text") {
      // K11 — no non-text Prompt block was ever observed (0/410 in the census),
      // but format drift must stay visible (fidelity contract): an image block
      // becomes the same placeholder Claude Code's R11 renders; any other kind
      // is recorded as an observable Drop rather than vanishing silently.
      if (block.kind === "image") {
        pieces.push("[image pasted]");
      } else {
        const raw = typeof block.data === "string" ? block.data : JSON.stringify(block.data ?? "");
        drops.push({
          reason: `K11: unknown block kind (${String(block.kind)})`,
          snippet: snippet(raw ?? ""),
          timestamp: ts || undefined,
        });
      }
      continue;
    }
    const raw = typeof block.data === "string" ? block.data : "";
    const text = raw.trim();
    if (text === "") {
      drops.push({ reason: "K6: empty piece", snippet: snippet(raw), timestamp: ts || undefined });
      continue;
    }
    // K14 — recover a live-steering message BEFORE the bracket-marker drop below
    // would discard the envelope (and the human's words inside it).
    const steered = recoverSteeringText(text);
    if (steered !== null) {
      pieces.push(steered);
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

  // K12 observability: live Prompt keys vs user-role Compaction-snapshot items.
  // A snapshot normally duplicates earlier same-file entries (ignored); a
  // snapshot prompt that never appears live (e.g. `/chat load`-imported
  // pre-compaction history) would otherwise be INVISIBLY absent — record it as
  // a Drop so the fidelity ledger shows it.
  const liveKeys = new Set<string>();
  const snapshotPrompts: { ts: string; text: string }[] = [];
  const scratchDrops: Drop[] = []; // snapshot pieces must not pollute the real ledger

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

    const data = parsed.data;

    // K12 — Compaction is never re-extracted, but its user-role snapshot items
    // are checked (post-loop) against the live prompts of this same file.
    if (parsed.kind === "Compaction") {
      const snapshot = isRecord(data) ? data.messages_snapshot : undefined;
      if (Array.isArray(snapshot)) {
        for (const item of snapshot) {
          if (!isRecord(item) || item.role !== "user") continue;
          const ts = normalizeTimestamp(item.meta);
          const text = promptText(item, scratchDrops, ts);
          if (text !== null) snapshotPrompts.push({ ts, text });
        }
      }
      continue;
    }

    // K14 — a mid-run steering message rides along on the next ToolResults
    // entry rather than arriving as its own Prompt. Admitted BEFORE the K1
    // Prompt-only gate below, which would otherwise skip the entry entirely.
    if (parsed.kind === "ToolResults") {
      const ts = normalizeTimestamp(isRecord(data) ? data.meta : undefined);
      for (const steered of steeringFromToolResults(data)) {
        messages.push({ timestamp: ts, text: steered });
        liveKeys.add(`${ts}\u0000${steered}`);
      }
      continue;
    }
    // K1 — only Prompt entries are candidate human input.
    if (parsed.kind !== "Prompt") continue;

    const ts = normalizeTimestamp(isRecord(data) ? data.meta : undefined);
    const text = promptText(data, drops, ts);
    if (text !== null) {
      messages.push({ timestamp: ts, text });
      liveKeys.add(`${ts}\u0000${text}`);
    }
  }

  for (const snap of snapshotPrompts) {
    if (!liveKeys.has(`${snap.ts}\u0000${snap.text}`)) {
      drops.push({
        reason: "K12: snapshot-only prompt",
        snippet: snippet(snap.text),
        timestamp: snap.ts || undefined,
      });
    }
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
    } else if (kind === "ToolResults") {
      // K14 — a steering message delivered on a ToolResults entry is a HUMAN
      // turn and must appear here too, or the SessionSource law breaks and
      // anaphora attributes context to the wrong turn. Everything else in a
      // ToolResults entry stays machine output and is not an event.
      const ts = normalizeTimestamp(isRecord(data) ? data.meta : undefined);
      for (const steered of steeringFromToolResults(data)) {
        events.push({ kind: "human", timestamp: ts, text: steered });
      }
    } else if (kind === "Clear" || kind === "Compaction") {
      // Hard context reset — closes antecedent/decision windows (K12).
      events.push({ kind: "boundary", timestamp: "", text: kind });
    }
    // Unknown kinds are not timeline events.
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
