import { styleText } from "node:util";

export const bold = (s: string): string => styleText("bold", s);
export const dim = (s: string): string => styleText("dim", s);
export const green = (s: string): string => styleText("green", s);
export const yellow = (s: string): string => styleText("yellow", s);
export const red = (s: string): string => styleText("red", s);
export const cyan = (s: string): string => styleText("cyan", s);

/** Render rows as aligned columns, padded to the max width per column. */
export function table(rows: string[][], opts?: { header?: string[] }): string {
  const all = opts?.header ? [opts.header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const render = (row: string[]): string =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = all.map(render);
  if (opts?.header) {
    const sep = dim(widths.map((w) => "-".repeat(w)).join("  "));
    lines.splice(1, 0, sep);
  }
  return lines.join("\n");
}

/** Funnel hint: the suggested next step, styled dim. */
export function hint(text: string): string {
  return dim(`→ next: ${text}`);
}
