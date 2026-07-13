import type { AnaphoraRecord } from "../../core/anaphora.js";
import { TAIL_CHARS } from "../../core/anaphora.js";
import { middleCut } from "../../core/budget.js";
import type { ClusterTask, Digest } from "../schemas.js";

/**
 * Stage 3 — author prompt builder: the heart of the tool.
 *
 * One call per task: the member sessions' human messages, resolved anaphora
 * records, and outcome classifications go in; the realistic ideal first
 * prompt — everything the human knew and wanted at t=0 but didn't say,
 * written in their own voice — comes out, plus observed durable preferences.
 *
 * Member/task input budgeting is the pipeline's job (core/budget.ts); this
 * builder inlines whatever content it is handed, already kept within budget
 * (or the task was blocked / cut upstream).
 *
 * The contract encoded below is pinned by the prompt-contract tests in
 * test/author.test.ts; bump `AUTHOR_PROMPT_VERSION` on any meaningful change.
 */
export const AUTHOR_PROMPT_VERSION = 1;

/** One member session's bundle of author inputs. */
export interface AuthorMemberInput {
  /** Export file name (the member id). */
  exportName: string;
  /** The human-only export markdown. */
  content: string;
  /** This session's digest (goal + outcome classification). */
  digest?: Digest;
  /** Resolved short-turn records for this session. */
  anaphora?: AnaphoraRecord[];
}

/** Input to {@link buildAuthorPrompt}. */
export interface AuthorPromptInput {
  task: ClusterTask;
  members: AuthorMemberInput[];
}

function renderAnaphora(records: AnaphoraRecord[]): string[] {
  const lines: string[] = [];
  for (const r of records) {
    if (!r.antecedent && !r.decision_kind) continue;
    lines.push(`  - at message #${r.index} the human said: ${JSON.stringify(r.human_text)}`);
    const decision = r.decision_text ? middleCut(r.decision_text, TAIL_CHARS).text : "";
    if (r.decision_kind === "plan") {
      lines.push(`    this approved a proposed plan:\n${indent(decision, 6)}`);
    } else if (r.decision_kind === "question") {
      lines.push(`    this answered:\n${indent(decision, 6)}`);
    }
    if (r.antecedent) {
      lines.push(`    tail of the assistant turn it replied to (MACHINE-AUTHORED, for
    resolving the reference only — never copy it):\n${indent(r.antecedent, 6)}`);
    }
  }
  return lines;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function renderMember(member: AuthorMemberInput): string {
  const parts: string[] = [`--- session ${member.exportName} ---`];
  if (member.digest) {
    parts.push(
      `digest: goal=${JSON.stringify(member.digest.goal)}; outcome=${member.digest.outcome}`,
    );
  }
  parts.push("human messages:", member.content);
  const anaphora = member.anaphora ? renderAnaphora(member.anaphora) : [];
  if (anaphora.length > 0) {
    parts.push("resolved short replies (what terse turns actually referred to):", ...anaphora);
  }
  parts.push(`--- end session ${member.exportName} ---`);
  return parts.join("\n");
}

/**
 * Build the stage-3 authoring prompt implementing the authoring contract:
 * the "knowable at t=0" test, transform-don't-leak, the effort budget,
 * inferred voice, verbatim-decision honoring, outcome-aware confidence,
 * and preference extraction with evidence.
 */
export function buildAuthorPrompt(input: AuthorPromptInput): string {
  const outcomes = input.members
    .map((m) => `${m.exportName}: ${m.digest?.outcome ?? "unclear"}`)
    .join(", ");

  return [
    "You are authoring the realistic ideal first prompt for a task a human already",
    "completed with a coding agent — the prompt they WOULD have written at the very",
    "start (t=0) if they had known then what they knew by the end. It goes into their",
    "personal prompt library to be pasted into a future session of the same kind.",
    "",
    `Task: ${input.task.title} (slug: ${input.task.slug})`,
    `Why these sessions form one task: ${input.task.rationale}`,
    `Member session outcomes: ${outcomes}`,
    "",
    'THE "KNOWABLE AT t=0" TEST — apply it to every candidate line: could the human',
    "plausibly have known or wanted this BEFORE the session started?",
    "",
    "Front-load (knowable at t=0):",
    "- the goal and the concrete deliverable;",
    "- output format and the quality bar;",
    "- tech stack and environment facts the human obviously already knew;",
    '- standing preferences and working style they exhibited (e.g. "diagnose before',
    '  acting, don\'t guess", "be honest about what\'s certain vs. inferred",',
    '  "make it idempotent", "back up before modifying");',
    "- constraints and things to avoid;",
    "- decisions the human resolved mid-session (fold them in as explicit",
    "  instructions — they were preferences all along).",
    "",
    "NEVER front-load (discovered during the session):",
    "- file paths first seen mid-session;",
    "- root causes;",
    "- specific config values or mechanisms;",
    "- error messages;",
    "- tools or facts the human visibly learned along the way.",
    "",
    "Transform, don't leak: where the session's value was an investigation the human",
    'steered, express the direction AS direction ("figure out why X happens; verify',
    "the mechanism against the actual config; state plainly what's certain vs.",
    'inferred") — never the answer the investigation found.',
    "",
    "THE EFFORT BUDGET — an ideal-but-untypeable prompt fails the mission exactly like",
    "an omniscient one:",
    "- target the length a motivated human would actually type: typically 100-300",
    "  words; go longer only when the task genuinely warrants it, prioritizing the",
    "  highest-leverage specifications;",
    "- prose-first, minimal structure: a paste-able prompt, not a spec with nested",
    "  headings and checklists.",
    "",
    "VOICE & PROVENANCE:",
    "- first person, in the human's own register as inferred from their messages",
    "  below (terse if they're terse) — never an asserted persona;",
    "- never copy assistant prose into the oneshot — assistant text appears below",
    "  only to resolve what short replies referred to;",
    "- [decision] lines are the human's verbatim choices — honor them;",
    "- [command] and [image pasted] lines show how they actually prompted (mention",
    "  supplying a screenshot if that was part of the task).",
    "",
    "CONFIDENCE — judge from the outcomes above:",
    '- "high" when member sessions completed;',
    '- "medium" when the best evidence is partial;',
    '- "low" when the trail is thin or mixed — say so rather than overclaim.',
    "",
    "PREFERENCES — separately, extract durable, recurring preferences worth carrying",
    "into EVERY future session (not one-off task details), each with a one-line",
    "evidence note pointing at what the human said or did.",
    "",
    "Respond with JSON:",
    `- "slug": exactly ${JSON.stringify(input.task.slug)};`,
    '- "title": a short human title for the library entry;',
    '- "oneshot_markdown": the prompt itself (markdown, but predominantly prose);',
    '- "confidence": "high" | "medium" | "low";',
    '- "preferences": [{"text", "evidence"}] (may be empty).',
    "",
    `=== MEMBER SESSIONS (${input.members.length}) ===`,
    ...input.members.map(renderMember),
    "=== END MEMBER SESSIONS ===",
  ].join("\n");
}
