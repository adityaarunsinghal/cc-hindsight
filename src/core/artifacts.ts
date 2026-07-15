import { z } from "zod";

/**
 * core/artifacts.ts — read-side validation for the tool's OWN on-disk
 * artifacts. The pipeline preaches tolerant parsing for inputs it doesn't own;
 * its own artifacts deserve at least a cheap schema check so a hand-edited or
 * older-version `sources.json` degrades gracefully instead of crashing a
 * browsing command (an unexpected confidence value must never turn into
 * `CONFIDENCE_COLOR[bad]()` → TypeError).
 *
 * Philosophy: LOOSE objects (unknown / future keys pass through untouched, so
 * newer fields survive an older reader) and per-field `.catch` fallbacks (one
 * bad field never sinks the whole entry). A parse fails — and the caller skips +
 * reports the entry — only when the value isn't a sources-shaped object at all.
 */

const PreferenceSchema = z.object({ text: z.string(), evidence: z.string() });

/** One truncation event recorded in provenance when `--truncate=extreme` cuts input. */
export const TruncationSchema = z.object({
  export: z.string(),
  block: z.number(),
  dropped_chars: z.number(),
});
export type Truncation = z.infer<typeof TruncationSchema>;

/**
 * Read schema for `library/<slug>/sources.json`. Kept structurally identical to
 * the write-side shape the author stage produces; new optional fields
 * (oneshot_hash, rating, input_coverage, truncations) are tolerated for
 * forward/backward compatibility. `slug` is the one hard requirement — a file
 * without it is not a sources record and is skipped.
 */
export const SourcesJsonSchema = z.looseObject({
  slug: z.string(),
  title: z.string().catch(""),
  members: z.array(z.string()).catch([]),
  sessionIds: z.array(z.string()).catch([]),
  preferences: z.array(PreferenceSchema).catch([]),
  outcome_summary: z.string().catch(""),
  domains: z.array(z.string()).catch([]),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
  authored_at: z.string().catch(""),
  model: z.string().nullable().catch(null),
  prompt_version: z.number().catch(0),
  tool_version: z.string().catch(""),
  generation: z.string().catch(""),
  // Optional provenance: truncation disclosure + the edit/rate verbs.
  oneshot_hash: z.string().optional(),
  rating: z.enum(["up", "down"]).nullable().optional(),
  rated_at: z.string().optional(),
  input_coverage: z.number().optional(),
  truncations: z.array(TruncationSchema).optional(),
});
export type SourcesJson = z.infer<typeof SourcesJsonSchema>;

/** Validate a parsed value as a sources record; null when it isn't one. */
export function parseSourcesJson(raw: unknown): SourcesJson | null {
  const result = SourcesJsonSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Read schema for one `anaphora.json` record. */
export const AnaphoraRecordSchema = z.looseObject({
  index: z.number(),
  timestamp: z.string().catch(""),
  human_text: z.string().catch(""),
  antecedent: z.string().nullable().catch(null),
  decision_kind: z.enum(["plan", "question"]).nullable().catch(null),
  decision_text: z.string().nullable().catch(null),
});

/**
 * Validate the `{export: records[]}` map from `anaphora.json`, dropping any
 * entry whose value isn't a well-formed record array. Returns a clean map
 * (never throws); a missing/garbage file simply yields {}.
 */
export function parseAnaphoraMap(
  raw: unknown,
): Record<string, z.infer<typeof AnaphoraRecordSchema>[]> {
  const out: Record<string, z.infer<typeof AnaphoraRecordSchema>[]> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = z.array(AnaphoraRecordSchema).safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}
