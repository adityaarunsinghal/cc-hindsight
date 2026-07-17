/**
 * core/extract.ts — compatibility shim.
 *
 * The Claude Code extractor moved to `src/sources/claude/extract.ts` and the
 * shared currency types (`ExtractedMessage`, `Drop`, `ExtractResult`,
 * `TimelineEvent`) to `src/sources/types.ts` when cc-hindsight grew a
 * multi-backend seam. This shim re-exports both so existing imports of
 * `core/extract.js` keep working unchanged.
 */

export {
  extractMessages,
  extractTimeline,
} from "../sources/claude/extract.js";
export type {
  Drop,
  ExtractedMessage,
  ExtractResult,
  TimelineEvent,
} from "../sources/types.js";
