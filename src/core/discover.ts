/**
 * core/discover.ts — compatibility shim.
 *
 * Claude Code discovery moved to `src/sources/claude/discover.ts` and the
 * `SessionInfo`/`ProjectInfo` types to `src/sources/types.ts` when cc-hindsight
 * grew a multi-backend seam. This shim re-exports both so existing imports of
 * `core/discover.js` keep working unchanged.
 */

export { decodeProjectDir, discoverProjects } from "../sources/claude/discover.js";
export type { ProjectInfo, SessionInfo } from "../sources/types.js";
