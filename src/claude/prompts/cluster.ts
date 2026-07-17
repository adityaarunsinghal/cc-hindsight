import type { Digest } from "../schemas.js";

/**
 * Stage 2 — cluster prompt builder.
 *
 * One call total: every session digest goes in; a task grouping comes out.
 * Grouping rules enforced here (and validated in the pipeline — slug
 * uniqueness and full coverage fail loudly):
 *
 *   - many-to-one: sessions pursuing the same underlying goal share a task;
 *     never force 1:1;
 *   - dual membership allowed when a session genuinely served two goals
 *     (explained in the rationale);
 *   - unique 2–5-word kebab-case slugs;
 *   - low-substance / trivia sessions route to `misc` (they author no
 *     oneshot) — junk must not dilute real tasks.
 *
 * `CLUSTER_PROMPT_VERSION` is recorded in provenance downstream; bump it on
 * any meaningful change to the prompt text.
 */
export const CLUSTER_PROMPT_VERSION = 3;

/** Render one digest as a compact labeled block. */
function renderDigest(exportName: string, digest: Digest): string {
  return [
    `- id: ${exportName}`,
    `  goal: ${digest.goal}`,
    `  deliverable: ${digest.deliverable}`,
    `  domain: ${digest.domain}`,
    `  keywords: ${digest.keywords.join(", ")}`,
    `  outcome: ${digest.outcome}`,
  ].join("\n");
}

/**
 * Build the stage-2 clustering prompt from the digests of every eligible
 * session (keyed by export file name — those names are the member ids the
 * response must use). `origins` names each session's backend (absent entries
 * ⇒ claude): a single-backend corpus is named ("Claude Code" / "Kiro CLI"),
 * a merged corpus goes neutral ("coding-agent"). All-claude input is
 * byte-identical to the pre-multi-backend prompt.
 */
export function buildClusterPrompt(
  digests: Record<string, Digest>,
  origins?: Record<string, "claude" | "kiro">,
): string {
  const ids = Object.keys(digests);
  const blocks = ids.map((id) => {
    const digest = digests[id];
    return digest ? renderDigest(id, digest) : `- id: ${id}`;
  });

  const originSet = new Set(ids.map((id) => origins?.[id] ?? "claude"));
  const sourceNoun =
    originSet.size > 1 ? "coding-agent" : originSet.has("kiro") ? "Kiro CLI" : "Claude Code";

  return [
    `You are grouping ${sourceNoun} sessions into semantic tasks for a personal`,
    "prompt library. Below are structured digests of every session, each with a",
    "unique id (its export file name).",
    "",
    "Group the sessions into tasks:",
    "- Sessions pursuing the SAME underlying goal belong in ONE task (many-to-one).",
    "  Never force one task per session; merging related work is the point.",
    "- A session may appear in two tasks ONLY when it genuinely served two goals;",
    "  explain any dual membership in the rationale.",
    "- Route low-substance or trivia sessions (quick questions, one-off lookups,",
    '  aborted starts) to "misc" — they will not become library entries.',
    "- Every id MUST appear in at least one task's members or in misc. Use ONLY",
    "  the ids listed below; never invent new ids.",
    "- Copy each id VERBATIM, character for character — including its `.md`",
    "  extension. Do not shorten, retype, or normalize ids.",
    "",
    "For each task provide:",
    '- "slug": unique kebab-case identifier of 2-5 words (e.g. "tmux-session-debugging").',
    '- "title": a short human-readable title.',
    '- "rationale": one or two sentences on why these sessions form one task',
    "  (and why any session belongs to two tasks).",
    '- "members": the ids of the sessions in this task.',
    "",
    `=== SESSION DIGESTS (${ids.length}) ===`,
    ...blocks,
    "=== END SESSION DIGESTS ===",
  ].join("\n");
}
