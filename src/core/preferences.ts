import type { LibraryEntry } from "./library.js";

/**
 * core/preferences.ts — deterministic preference aggregation (§5.8, F8).
 *
 * Collect `preferences[]` from every library entry's `sources.json`,
 * normalize, dedupe near-identical strings, rank by frequency × recency, and
 * emit a paste-ready `CLAUDE.md` block with evidence counts. No LLM here —
 * the optional `--consolidate` pass lives behind the consent gate in the
 * preferences command.
 */

/** One aggregated preference across the library. */
export interface AggregatedPreference {
  /** Canonical text (the most recently authored phrasing). */
  text: string;
  /** Number of tasks that stated it. */
  count: number;
  /** Which tasks, with their one-line evidence. */
  occurrences: { slug: string; evidence: string }[];
  /** Most recent authored_at among the occurrences (recency tiebreak). */
  lastAuthoredAt: string;
}

/**
 * Normalization key for near-identical dedupe: trim, case-fold, collapse
 * whitespace, strip punctuation. "Diagnose before acting." and "diagnose
 * before acting" are the same preference.
 */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aggregate preferences from library entries: dedupe by normalized key, count
 * per-task occurrences (a task stating the same thing twice counts once),
 * rank by frequency desc, then recency desc, then text asc (determinism).
 */
export function aggregatePreferences(entries: LibraryEntry[]): AggregatedPreference[] {
  const byKey = new Map<string, AggregatedPreference>();

  for (const entry of entries) {
    const seenInTask = new Set<string>();
    for (const pref of entry.sources.preferences ?? []) {
      const key = normalizeKey(pref.text);
      if (!key || seenInTask.has(key)) continue;
      seenInTask.add(key);

      const authoredAt = entry.sources.authored_at ?? "";
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        existing.occurrences.push({ slug: entry.slug, evidence: pref.evidence });
        if (authoredAt > existing.lastAuthoredAt) {
          existing.lastAuthoredAt = authoredAt;
          existing.text = pref.text.trim(); // newest phrasing wins
        }
      } else {
        byKey.set(key, {
          text: pref.text.trim(),
          count: 1,
          occurrences: [{ slug: entry.slug, evidence: pref.evidence }],
          lastAuthoredAt: authoredAt,
        });
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastAuthoredAt.localeCompare(a.lastAuthoredAt) ||
      a.text.localeCompare(b.text),
  );
}

/**
 * Render the paste-ready `CLAUDE.md` block: a comment header, one bullet per
 * preference, an evidence count per line ("stated in 7 of 12 tasks").
 */
export function renderClaudeMdBlock(
  prefs: AggregatedPreference[],
  taskCount: number,
  now = new Date(),
): string {
  const lines = [
    `<!-- cc-hindsight preferences · generated ${now.toISOString().slice(0, 10)} -->`,
    "## Working preferences",
    "",
  ];
  for (const p of prefs) {
    const evidence =
      taskCount > 1 && p.occurrences.length > 0
        ? ` <!-- stated in ${p.count} of ${taskCount} tasks -->`
        : "";
    lines.push(`- ${p.text}${evidence}`);
  }
  return lines.join("\n");
}
