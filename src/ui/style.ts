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

/**
 * Render rows as aligned columns. Cells may carry ANSI styling — widths are
 * measured on visible characters, so color never breaks alignment.
 */
export function table(rows: string[][], opts?: { header?: string[] }): string {
  const header = opts?.header?.map(bold);
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const render = (row: string[]): string =>
    row
      .map((cell, i) => padVisible(cell, widths[i] ?? 0))
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
