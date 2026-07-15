/**
 * core/render.ts — deterministic, byte-stable export rendering.
 *
 * Turns a deduped corpus session into the per-session markdown artifact and
 * allocates its `<project>-<uuid8>.md` filename. Pure and deterministic: given
 * the same corpus, every run produces byte-identical output (the `export`
 * command asserts idempotency on this).
 */

import type { CorpusSession } from "./dedupe.js";

/**
 * Render one session to human-only markdown.
 *
 * Format: an HTML comment header carrying the source path and message
 * count, then one `### <timestamp>` block per message with the message text
 * beneath it, chronological, blank-line separated. The output always ends with
 * a single trailing newline so files are POSIX-clean and re-run identical.
 */
export function renderExport(session: CorpusSession): string {
  const header = `<!-- source: ${session.sourcePath}\n     messages: ${session.messages.length} -->\n`;
  // Each block starts with a blank line, so the header, every heading, and
  // every body are separated by exactly one blank line; each block ends in \n.
  const blocks = session.messages
    .map((message) => `\n### ${message.timestamp}\n\n${message.text}\n`)
    .join("");
  return header + blocks;
}

/** Characters unsafe in a filename are collapsed to a single dash. */
function sanitize(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Allocate a deterministic export filename: `<project>-<uuid8>.md`, where
 * `uuid8` is the first 8 characters of the session id (a real Claude Code
 * session id is a UUID; a non-uuid basename simply contributes its first 8
 * characters of stem). Both parts are filesystem-sanitized.
 *
 * `used` tracks names already allocated THIS run. On collision the id prefix is
 * lengthened one character at a time until unique; if the whole id is consumed
 * and still collides, a numeric suffix is appended. Callers share one `used`
 * set across the run so the allocation is stable and collision-free.
 */
export function exportFileName(
  project: string,
  sessionId: string,
  used: Set<string> = new Set(),
): string {
  const proj = sanitize(project) || "project";
  const stem = sanitize(sessionId) || "session";

  let length = 8;
  let name = `${proj}-${stem.slice(0, length)}.md`;
  while (used.has(name)) {
    if (length < stem.length) {
      length++;
      name = `${proj}-${stem.slice(0, length)}.md`;
      continue;
    }
    // Whole id consumed and still colliding: append a numeric suffix.
    let counter = 2;
    while (used.has(`${proj}-${stem}-${counter}.md`)) counter++;
    name = `${proj}-${stem}-${counter}.md`;
    break;
  }

  used.add(name);
  return name;
}
