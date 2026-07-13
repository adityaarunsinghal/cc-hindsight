import { styleText } from "node:util";

export const bold = (s: string): string => styleText("bold", s);
export const dim = (s: string): string => styleText("dim", s);
export const green = (s: string): string => styleText("green", s);
export const yellow = (s: string): string => styleText("yellow", s);
export const red = (s: string): string => styleText("red", s);
export const cyan = (s: string): string => styleText("cyan", s);
export const magenta = (s: string): string => styleText("magenta", s);

/** Visible length of a string: ANSI escape sequences take no columns. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI, "").length;

/** Pad to a visible width, styling-safe. */
const padVisible = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - visibleLength(s)));

/** Columns are never shrunk below this many visible characters. */
const MIN_COL_WIDTH = 6;

/** Sticky variant of {@link ANSI}: matches only at `lastIndex` (loop-safe). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_AT = /\u001b\[[0-9;]*m/y;

/**
 * Truncate a (possibly ANSI-styled) cell to `width` visible columns with a
 * trailing ellipsis. Escape sequences are copied through untouched (they take
 * no columns), and a full reset is appended after the cut so a style opened
 * inside the kept part can never bleed into the rest of the table.
 */
function truncateVisible(cell: string, width: number): string {
  if (visibleLength(cell) <= width) return cell;
  let out = "";
  let visible = 0;
  for (let i = 0; i < cell.length; ) {
    ANSI_AT.lastIndex = i;
    const m = ANSI_AT.exec(cell);
    if (m) {
      out += m[0]; // escape sequence: zero columns, copy verbatim
      i += m[0].length;
      continue;
    }
    if (visible === width - 1) break; // leave room for the ellipsis
    out += cell[i];
    visible++;
    i++;
  }
  return `${out}…${cell.includes("\u001b[") ? "\u001b[0m" : ""}`;
}

/**
 * Render rows as aligned columns. Cells may carry ANSI styling — widths are
 * measured on visible characters, so color never breaks alignment.
 *
 * When the natural table is wider than `maxWidth` (default: the terminal
 * width, TTY only), the widest columns are shrunk first — down to
 * {@link MIN_COL_WIDTH} at most — and overlong cells get an ANSI-safe
 * ellipsis. Piped output is never capped: `list | grep` sees full content.
 */
export function table(rows: string[][], opts?: { header?: string[]; maxWidth?: number }): string {
  const header = opts?.header?.map(bold);
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }

  // Cap the total width by greedily shrinking the widest column one column at
  // a time — spreads the loss across the offenders (Title, Domain) instead of
  // gutting one, and never touches already-narrow columns.
  const maxWidth =
    opts?.maxWidth ?? (process.stdout.isTTY ? (process.stdout.columns ?? undefined) : undefined);
  if (maxWidth !== undefined) {
    const gaps = 2 * (widths.length - 1);
    let total = widths.reduce((a, b) => a + b, gaps);
    while (total > maxWidth) {
      let widest = 0;
      for (let i = 1; i < widths.length; i++) {
        if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
      }
      if ((widths[widest] ?? 0) <= MIN_COL_WIDTH) break; // nothing left to shrink
      widths[widest] = (widths[widest] ?? 0) - 1;
      total--;
    }
  }

  const render = (row: string[]): string =>
    row
      .map((cell, i) => padVisible(truncateVisible(cell, widths[i] ?? 0), widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = all.map(render);
  if (header) {
    const sep = dim(widths.map((w) => "-".repeat(w)).join("  "));
    lines.splice(1, 0, sep);
  }
  return lines.join("\n");
}

/** Funnel hint: the suggested next step, styled dim. */
export function hint(text: string): string {
  return dim(`→ next: ${text}`);
}
