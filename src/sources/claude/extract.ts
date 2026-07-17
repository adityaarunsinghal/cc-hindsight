/**
 * sources/claude/extract.ts — the audited Claude Code extractor: the fidelity
 * contract. (Moved from src/core/extract.ts; a re-export shim keeps the old
 * import path working.)
 *
 * Pure module: input is the raw JSONL lines of ONE Claude Code session file;
 * output is the human-authored messages plus an observable record of every
 * dropped piece — false drops must be visible under `--verbose`, never
 * silent. No filesystem access, so it is trivially unit-testable.
 *
 * Implements extraction rules R1–R7, R10, R11. Each rule below is commented
 * with the transcript shape it handles and is pinned by a dedicated fixture
 * under test/fixtures/extract/. Parsing is tolerant: unknown fields are
 * ignored, admission/rejection is allow-list based, and corrupt lines are
 * skipped and counted rather than aborting the whole session.
 */

import type { Drop, ExtractedMessage, ExtractResult, TimelineEvent } from "../types.js";

/** R6: known interruption markers — machine-authored, never human input. */
const INTERRUPTION_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

/** R5: tool-rejection boilerplate marker; the human's follow-up is AFTER it. */
const TOOL_REJECTION_MARKER = "the user said:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and cap at 120 chars for a Drop snippet. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/**
 * R10 — command recovery. Human slash-command invocations arrive as XML inside
 * a user entry's content, e.g.:
 *   <command-message>review is analyzing…</command-message>
 *   <command-name>/review</command-name>
 *   <command-args>src/</command-args>
 * → "[command] /review src/". This runs BEFORE R6's leading-'<' drop so the
 * invocation survives (order matters); <local-command-stdout> carries no
 * <command-name> tag and therefore still drops under R6. Custom project
 * commands (any <command-name>) with args are included.
 */
function recoverCommand(raw: string): string | null {
  const nameMatch = /<command-name>([^<]*)<\/command-name>/.exec(raw);
  if (!nameMatch) return null;
  let name = (nameMatch[1] ?? "").trim();
  if (name === "") return null;
  if (!name.startsWith("/")) name = `/${name}`;
  const argsMatch = /<command-args>([^<]*)<\/command-args>/.exec(raw);
  const args = (argsMatch?.[1] ?? "").trim();
  return args === "" ? `[command] ${name}` : `[command] ${name} ${args}`;
}

/**
 * R6 — per-piece cleaning, applied to every piece independently so a machine
 * block never takes accompanying human prose down with it. Trim; drop empty;
 * drop pieces whose first char is '<' (machine-injected, e.g. <ide_opened_file>,
 * <local-command-stdout>, <system-reminder>); drop interruption markers. Every
 * dropped piece becomes a Drop record. R10 is attempted first so commands live.
 */
function cleanPiece(raw: string, pieces: string[], drops: Drop[], ts: string | undefined): void {
  const command = recoverCommand(raw);
  if (command !== null) {
    pieces.push(command);
    return;
  }
  const text = raw.trim();
  if (text === "") {
    drops.push({ reason: "R6: empty piece", snippet: snippet(raw), timestamp: ts });
    return;
  }
  if (text.startsWith("<")) {
    drops.push({ reason: "R6: machine block (leading <)", snippet: snippet(text), timestamp: ts });
    return;
  }
  if (INTERRUPTION_MARKERS.has(text)) {
    drops.push({ reason: "R6: interruption marker", snippet: snippet(text), timestamp: ts });
    return;
  }
  pieces.push(text);
}

/** Flatten a tool_result block's `content` (string, or array of text blocks). */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text")
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

/**
 * R7 — AskUserQuestion decision recovery. The assistant asks via the
 * AskUserQuestion tool; the human's selection comes back on the *user* entry's
 * `toolUseResult`. Assumed shape (pinned by r7-decision.jsonl):
 *   "toolUseResult": {
 *     "questions": [ { "question": "…", "answer": "…" }, … ]
 *   }
 * `answer` may be a string or an array of strings (multi-select → joined ", ").
 * Rendered verbatim as: [decision] "<question>" → <answer>.
 */
function extractDecisions(entry: Record<string, unknown>): string[] {
  const result = entry.toolUseResult;
  if (!isRecord(result)) return [];
  const questions = result.questions;
  if (!Array.isArray(questions)) return [];
  const lines: string[] = [];
  for (const q of questions) {
    if (!isRecord(q)) continue;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    let answer = "";
    if (typeof q.answer === "string") {
      answer = q.answer.trim();
    } else if (Array.isArray(q.answer)) {
      answer = q.answer.filter((a): a is string => typeof a === "string").join(", ");
    }
    if (question === "" || answer === "") continue;
    lines.push(`[decision] "${question}" → ${answer}`);
  }
  return lines;
}

/**
 * R2 — rejection, checked BEFORE reading content (allow-list friendly). Drops
 * model-authored / automation entries: isMeta, isSidechain (subagent threads),
 * isCompactSummary / isVisibleInTranscriptOnly (model-authored /compact
 * summaries), or `entrypoint` starting with "sdk" (automation). We deliberately
 * do NOT key on `promptSource === "sdk"` — VS Code sets promptSource on genuine
 * human typing (see r2-promptsource-guard.jsonl). Returns the reason, or null
 * to keep the entry.
 */
function rejectReason(entry: Record<string, unknown>): string | null {
  if (entry.isMeta) return "R2: isMeta";
  if (entry.isSidechain) return "R2: isSidechain";
  if (entry.isCompactSummary) return "R2: isCompactSummary";
  if (entry.isVisibleInTranscriptOnly) return "R2: isVisibleInTranscriptOnly";
  if (typeof entry.entrypoint === "string" && entry.entrypoint.startsWith("sdk")) {
    return "R2: sdk entrypoint";
  }
  return null;
}

/**
 * R3 — attachments hold messages typed while the agent was busy. Assumed shape
 * (pinned by r3-queued-command.jsonl):
 *   { "type": "attachment",
 *     "attachment": { "type": "queued_command",
 *                     "origin": { "kind": "human" },
 *                     "commandMode": "prompt",
 *                     "text": "the queued prompt text" } }
 * Admit ONLY queued_command + origin.kind==="human" + commandMode==="prompt";
 * anything else is recorded as a Drop for observability.
 */
function collectAttachment(
  entry: Record<string, unknown>,
  pieces: string[],
  drops: Drop[],
  ts: string | undefined,
): void {
  const att = entry.attachment;
  if (
    isRecord(att) &&
    att.type === "queued_command" &&
    isRecord(att.origin) &&
    att.origin.kind === "human" &&
    att.commandMode === "prompt"
  ) {
    cleanPiece(typeof att.text === "string" ? att.text : "", pieces, drops, ts);
    return;
  }
  drops.push({
    reason: "R3: non-human or non-prompt attachment",
    snippet: entrySnippet(entry),
    timestamp: ts,
  });
}

/**
 * R4/R5/R6/R10/R11 over a user entry's message.content.
 * - R4: content as string → clean per R6 (R10 command probed first).
 * - R5: content as array → collect {type:'text'} block texts; from
 *   {type:'tool_result'} blocks recover ONLY the human follow-up after the
 *   'the user said:' rejection marker (preceding text is boilerplate); other
 *   tool_result content is machine output and is ignored (never a candidate).
 * - R11: {type:'image'} (and document/binary) blocks → '[image pasted]'
 *   placeholder in position.
 */
function collectUserContent(
  entry: Record<string, unknown>,
  pieces: string[],
  drops: Drop[],
  ts: string | undefined,
): void {
  const message = entry.message;
  if (!isRecord(message)) return;
  const content = message.content;

  // R4 — string content.
  if (typeof content === "string") {
    cleanPiece(content, pieces, drops, ts);
    return;
  }
  if (!Array.isArray(content)) return;

  // R5/R6/R10/R11 — array content, one block (then one piece) at a time.
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      cleanPiece(typeof block.text === "string" ? block.text : "", pieces, drops, ts);
    } else if (block.type === "image" || block.type === "document") {
      // R11 — non-text human input keeps its position as a placeholder.
      pieces.push("[image pasted]");
    } else if (block.type === "tool_result") {
      const text = toolResultText(block);
      const idx = text.indexOf(TOOL_REJECTION_MARKER);
      if (idx >= 0) {
        cleanPiece(text.slice(idx + TOOL_REJECTION_MARKER.length), pieces, drops, ts);
      }
      // Non-rejection tool_result is machine output: ignored (not a Drop — it
      // was never a candidate human piece).
    }
    // Unknown block types are ignored (tolerant parsing).
  }
}

/** Best-effort content excerpt of a rejected entry for its Drop snippet. */
function entrySnippet(entry: Record<string, unknown>): string {
  const message = entry.message;
  if (isRecord(message)) {
    const content = message.content;
    if (typeof content === "string") return snippet(content);
    if (Array.isArray(content)) {
      const joined = content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join(" ");
      if (joined.trim() !== "") return snippet(joined);
    }
  }
  const att = entry.attachment;
  if (isRecord(att) && typeof att.text === "string") return snippet(att.text);
  return snippet(JSON.stringify(entry));
}

/**
 * Extract human-authored messages from one session's raw JSONL lines.
 *
 * Behavioral notes:
 * - Entries missing `timestamp` are tolerated: kept with entry order preserved
 *   and emitted with `timestamp: ""` (dedupe/anaphora key on order downstream).
 * - A message with zero surviving pieces emits no ExtractedMessage.
 * - Blank lines are skipped silently; any line that fails to parse (or parses
 *   to a non-object) is skipped and counted in `badLines` — never aborting.
 */
export function extractMessages(lines: string[]): ExtractResult {
  const messages: ExtractedMessage[] = [];
  const drops: Drop[] = [];
  let badLines = 0;

  for (const line of lines) {
    if (line.trim() === "") continue; // blank line: not an entry, not corrupt.

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isRecord(parsed)) {
      badLines++; // valid JSON but not a transcript-entry object.
      continue;
    }

    const entry = parsed;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

    // R1 — admission: only 'user' and 'attachment' entries are candidate human
    // input. Everything else (assistant/summary/system/…) is silently not a
    // candidate (not a Drop — it was never claimed to be human input).
    if (entry.type !== "user" && entry.type !== "attachment") continue;

    // R2 — rejection, before reading content.
    const reject = rejectReason(entry);
    if (reject !== null) {
      drops.push({ reason: reject, snippet: entrySnippet(entry), timestamp: ts });
      continue;
    }

    const text = humanEntryText(entry, drops, ts);
    if (text !== null) {
      messages.push({ timestamp: ts ?? "", text });
    }
  }

  return { messages, drops, badLines };
}

/**
 * Collect and join the surviving human pieces of ONE already-admitted (post-R1
 * admission, post-R2 rejection) `user` or `attachment` entry, applying
 * R3–R7/R10/R11. Returns the joined text (pieces separated by a blank line) or
 * `null` when nothing human survived.
 *
 * Extracted so {@link extractMessages} and {@link extractTimeline} produce
 * byte-identical human-message text — the dedupe key and the anaphora↔export
 * index alignment both depend on the two paths agreeing exactly.
 */
function humanEntryText(
  entry: Record<string, unknown>,
  drops: Drop[],
  ts: string | undefined,
): string | null {
  const pieces: string[] = [];
  if (entry.type === "attachment") {
    collectAttachment(entry, pieces, drops, ts); // R3
  } else {
    collectUserContent(entry, pieces, drops, ts); // R4/R5/R6/R10/R11
    for (const decision of extractDecisions(entry)) pieces.push(decision); // R7
  }
  return pieces.length > 0 ? pieces.join("\n\n") : null;
}

/**
 * Render an `AskUserQuestion` tool_use `input` into a compact one-liner surface.
 * Assumed shape (tolerated variants noted):
 *   input.questions: [ { question: string, header?: string,
 *                        options: ({ label: string, ... } | string)[],
 *                        multiSelect?: boolean }, … ]
 * Each question becomes `"<question> [<opt>, <opt>, …]"`; options may be plain
 * strings OR objects with a `label`. Missing/blank questions are skipped;
 * multiple questions are newline-joined.
 */
function renderQuestion(input: unknown): string {
  if (!isRecord(input)) return "";
  const questions = input.questions;
  if (!Array.isArray(questions)) return "";
  const lines: string[] = [];
  for (const q of questions) {
    if (!isRecord(q)) continue;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (question === "") continue;
    const labels: string[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (typeof opt === "string") {
          const label = opt.trim();
          if (label !== "") labels.push(label);
        } else if (isRecord(opt) && typeof opt.label === "string") {
          const label = opt.label.trim();
          if (label !== "") labels.push(label);
        }
      }
    }
    // A multi-select question can be answered with several options at once; note
    // it so the author stage doesn't misread a terse "option 2" against what was
    // actually a pick-many surface.
    const multi = q.multiSelect === true ? " (multi-select)" : "";
    lines.push(
      labels.length > 0 ? `${question} [${labels.join(", ")}]${multi}` : `${question}${multi}`,
    );
  }
  return lines.join("\n");
}

/**
 * Emit the timeline events of ONE assistant entry, in content-block order.
 *
 * Assistant `message.content` is a string OR an array of blocks. `{type:'text'}`
 * blocks accumulate into a single `assistant` event; an `ExitPlanMode` /
 * `AskUserQuestion` `{type:'tool_use'}` block flushes any buffered text FIRST
 * (so the text that introduced the tool call precedes it chronologically) and
 * then emits the `plan` / `question` event. Assumed tool_use shapes:
 *   { type:'tool_use', name:'ExitPlanMode',    input:{ plan: string } }
 *   { type:'tool_use', name:'AskUserQuestion', input:{ questions:[…] } }
 * Unknown tool_use names are ignored (tolerant parsing).
 */
function assistantEvents(entry: Record<string, unknown>, ts: string): TimelineEvent[] {
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  const events: TimelineEvent[] = [];

  if (typeof content === "string") {
    const text = content.trim();
    if (text !== "") events.push({ kind: "assistant", timestamp: ts, text });
    return events;
  }
  if (!Array.isArray(content)) return events;

  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text !== "") events.push({ kind: "assistant", timestamp: ts, text });
    buffer = [];
  };

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string") buffer.push(block.text);
    } else if (block.type === "tool_use") {
      if (block.name === "ExitPlanMode") {
        flush();
        const plan =
          isRecord(block.input) && typeof block.input.plan === "string" ? block.input.plan : "";
        events.push({ kind: "plan", timestamp: ts, text: plan });
      } else if (block.name === "AskUserQuestion") {
        flush();
        events.push({ kind: "question", timestamp: ts, text: renderQuestion(block.input) });
      }
    }
  }
  flush();
  return events;
}

/**
 * Build a session file's linear timeline of human turns, assistant text turns,
 * and pending plan/question surfaces (consumed by core/anaphora.ts and
 * core/outcome.ts). Same tolerant parsing as {@link extractMessages}:
 * blank/corrupt lines are skipped, unknown fields ignored.
 *
 * R2 rejection is applied to EVERY entry — not just `user`/`attachment` — so a
 * subagent/sidechain (`isSidechain`), meta, or sdk-automation assistant turn can
 * NEVER become an antecedent (R2 stays single-sourced). Human-turn text
 * is produced by the SAME {@link humanEntryText} the exporter uses, so timeline
 * human turns align 1:1 (by timestamp+text) with the deduped, exported corpus.
 */
export function extractTimeline(lines: string[]): TimelineEvent[] {
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

    const entry = parsed;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";

    // R2 — rejection first, over ALL entry types (single-sourced).
    if (rejectReason(entry) !== null) continue;

    if (entry.type === "user" || entry.type === "attachment") {
      const text = humanEntryText(entry, scratchDrops, ts === "" ? undefined : ts);
      if (text !== null) events.push({ kind: "human", timestamp: ts, text });
    } else if (entry.type === "assistant") {
      for (const event of assistantEvents(entry, ts)) events.push(event);
    }
    // Other entry types (summary/system/…) are not timeline events.
  }

  return events;
}
