import { isEdited, type LibraryEntry } from "../core/library.js";
import { bold, dim, green, magenta, red, table, yellow } from "./style.js";

/**
 * ui/library-table.ts — the styled library listing, shared by the `list`
 * command and the post-distill "here's what you just built" display so the two
 * render byte-identically and can never drift.
 */

const CONFIDENCE_COLOR = { high: green, medium: yellow, low: red } as const;

/** Badge column: hand-edited marker + rating verdict. */
function badges(edited: boolean, rating: "up" | "down" | null | undefined): string {
  const parts: string[] = [];
  if (edited) parts.push(yellow("✎ edited"));
  if (rating === "up") parts.push(green("▲"));
  if (rating === "down") parts.push(red("▼"));
  return parts.join(" ");
}

/** Render library entries as the aligned, colorized table both callers print. */
export function renderLibraryTable(entries: LibraryEntry[]): string {
  return table(
    entries.map((e) => [
      bold(e.slug),
      e.sources.title,
      magenta(e.sources.domains.join(", ")),
      String(e.sources.members.length),
      (CONFIDENCE_COLOR[e.sources.confidence] ?? dim)(e.sources.confidence),
      dim(e.sources.authored_at.slice(0, 10)),
      badges(isEdited(e), e.sources.rating),
    ]),
    { header: ["Slug", "Title", "Domain", "Sessions", "Confidence", "Authored", ""] },
  );
}
