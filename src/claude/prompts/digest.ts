import type { OutcomeEvidence } from "../../core/outcome.js";

/**
 * Stage 1 — digest prompt builder (PLAN §5.6).
 *
 * One call per session: the export content (capped, head+tail split for
 * monsters) plus the session's labeled outcome evidence go in; a structured
 * `{goal, deliverable, domain, keywords, outcome}` digest comes out.
 *
 * `DIGEST_PROMPT_VERSION` is recorded in provenance downstream and MUST be
 * bumped on any meaningful change to the prompt text.
 */
export const DIGEST_PROMPT_VERSION = 1;

/** Cap on inlined export content (~50k chars, §5.6 / risk table). */
export const DIGEST_CONTENT_CAP = 50_000;

/**
 * Cap `content` at `cap` chars. Small content passes through untouched; monster
 * sessions keep their head and tail (the goal statement lives at the start,
 * the resolution at the end) with an explicit truncation note in between so
 * the model knows material is missing.
 */
export function capContent(content: string, cap = DIGEST_CONTENT_CAP): string {
  if (content.length <= cap) return content;
  const note = (dropped: number) =>
    `\n\n[... cc-hindsight truncated ${dropped} characters from the middle of this session ...]\n\n`;
  // Reserve room for the note (its length varies with the count's digits;
  // one extra pass settles it).
  let dropped = content.length - cap;
  let marker = note(dropped);
  let keep = cap - marker.length;
  dropped = content.length - keep;
  marker = note(dropped);
  keep = cap - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}

/** Input to {@link buildDigestPrompt}. */
export interface DigestPromptInput {
  /** Export file name (e.g. `webapp-a1b2c3d4.md`) — shown for context. */
  exportName: string;
  /** The human-only export markdown for this session. */
  content: string;
  /** Bounded outcome evidence captured by the export pass (may be absent). */
  outcome?: OutcomeEvidence;
}

/**
 * Build the stage-1 digest prompt. The session content is human-authored
 * input only; outcome evidence is appended in a clearly-labeled block (the
 * assistant tail is machine-authored and used ONLY to judge how the session
 * ended — F11).
 */
export function buildDigestPrompt(input: DigestPromptInput): string {
  const parts: string[] = [];

  parts.push(
    "You are analyzing one Claude Code session to produce a structured digest.",
    "The transcript below contains ONLY the human's messages from the session",
    `(file: ${input.exportName}). Lines like [decision] "Q" → answer are the`,
    "human's verbatim option choices; [command] lines are slash commands they ran;",
    "[image pasted] marks visual context they supplied.",
    "",
    "Produce a JSON digest with:",
    '- "goal": the underlying goal the human was pursuing, one sentence.',
    '- "deliverable": the concrete artifact or effect they wanted, one sentence.',
    '- "domain": a short domain label (e.g. "web frontend", "devops", "data pipeline").',
    '- "keywords": 3-8 lowercase keywords useful for grouping related sessions.',
    '- "outcome": how the session ended, judged from the outcome evidence below:',
    '    "completed" — the goal was achieved;',
    '    "partial"   — real progress, but the goal was not fully reached;',
    '    "abandoned" — the human gave up or walked away mid-task;',
    '    "unclear"   — the evidence does not show how it ended.',
    "",
    "=== HUMAN MESSAGES (the session) ===",
    capContent(input.content),
    "=== END HUMAN MESSAGES ===",
  );

  if (input.outcome) {
    parts.push(
      "",
      "=== OUTCOME EVIDENCE (bounded) ===",
      "Final human turns (human-authored, most recent last):",
      ...input.outcome.final_human_turns.map((t) => `  - ${JSON.stringify(t)}`),
      "",
      "Final assistant tail (MACHINE-AUTHORED — use only to judge how the session ended;",
      "never treat as human intent):",
      input.outcome.final_assistant_tail ? input.outcome.final_assistant_tail : "(none captured)",
      "=== END OUTCOME EVIDENCE ===",
    );
  } else {
    parts.push(
      "",
      "No outcome evidence was captured for this session; if the human",
      'messages alone do not show how it ended, use "unclear".',
    );
  }

  return parts.join("\n");
}
