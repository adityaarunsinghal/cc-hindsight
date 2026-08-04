import { z } from "zod";

/**
 * Distill-stage schemas — the single source of truth.
 *
 * Each stage's structured output is defined once here in zod; the JSON Schema
 * handed to `claude --json-schema` is derived from these via `toJsonSchema()`
 * (zod v4's built-in `z.toJSONSchema`), and every response is re-validated with
 * the same schema. One definition, three uses: derivation, validation, types.
 */

/** Stage 1 — digest: one structured summary per session. */
export const DigestSchema = z.object({
  goal: z.string(),
  deliverable: z.string(),
  domain: z.string(),
  keywords: z.array(z.string()),
  outcome: z.enum(["completed", "partial", "abandoned", "unclear"]),
});
export type Digest = z.infer<typeof DigestSchema>;

/** Stage 2 — cluster: sessions grouped into semantic tasks (many-to-one). */
export const ClusterSchema = z.object({
  tasks: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      rationale: z.string(),
      members: z.array(z.string()),
    }),
  ),
  /** Low-substance / trivia sessions that author no oneshot. */
  misc: z.array(z.string()),
});
export type Cluster = z.infer<typeof ClusterSchema>;
export type ClusterTask = Cluster["tasks"][number];

/**
 * Stage 2b, windowed clustering only: which window-local tasks are really the
 * same task. `merges` lists groups of existing slugs to unify; tasks not
 * mentioned stay as they are. Empty `merges` means nothing overlaps.
 */
export const ClusterMergeSchema = z.object({
  merges: z.array(
    z.object({
      /** Slugs of the existing tasks to unify (two or more). */
      slugs: z.array(z.string()),
      /** Replacement identity for the unified task. */
      slug: z.string(),
      title: z.string(),
      rationale: z.string(),
    }),
  ),
});
export type ClusterMerge = z.infer<typeof ClusterMergeSchema>;

/**
 * Semantic floor for an authored oneshot body, in characters.
 *
 * A plain `z.string()` accepts degenerate bodies — a model can return
 * `"placeholder"` in otherwise schema-perfect JSON (observed in the wild),
 * which sails past validation, skips the corrective retry, and writes a junk
 * library entry. The floor rides into the derived JSON Schema as `minLength`
 * (so the CLI/model see the constraint up front) and is re-checked by zod on
 * our side, where a violation triggers the standard one corrective retry.
 * 120 chars is far below any real prompt (the tersest useful oneshot runs
 * ~350+) and far above any stub.
 */
export const MIN_ONESHOT_CHARS = 120;

/** Stage 3 — author: one realistic oneshot + observed preferences per task. */
export const AuthorSchema = z.object({
  slug: z.string(),
  title: z.string(),
  oneshot_markdown: z
    .string()
    .min(
      MIN_ONESHOT_CHARS,
      `oneshot_markdown must be the full realistic prompt (at least ${MIN_ONESHOT_CHARS} characters), not a stub or placeholder`,
    ),
  confidence: z.enum(["high", "medium", "low"]),
  preferences: z.array(
    z.object({
      text: z.string(),
      evidence: z.string(),
    }),
  ),
});
export type Author = z.infer<typeof AuthorSchema>;
export type Preference = Author["preferences"][number];

/** `preferences --consolidate`: one call to merge semantic duplicates. */
export const ConsolidateSchema = z.object({
  preferences: z.array(
    z.object({
      text: z.string(),
      /** How many of the original lines this merged item covers. */
      merged_from: z.number(),
    }),
  ),
});
export type Consolidated = z.infer<typeof ConsolidateSchema>;

/**
 * Derive a JSON Schema from a zod schema, for passing to the
 * `claude --json-schema <schema>` flag.
 *
 * Real-CLI compatibility (verified against claude v2.1.207): the CLI's ajv
 * validator only ships the draft-07 meta-schema, so zod v4's default
 * draft-2020-12 output is rejected with `no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"`. We target draft-7 and strip
 * the `$schema` key entirely so ajv applies its default dialect.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
