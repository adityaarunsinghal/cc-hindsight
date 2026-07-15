import { describe, expect, it } from "vitest";
import { renderMarkdownAnsi } from "../src/ui/markdown.js";

const plain = (md: string, width = 40) => renderMarkdownAnsi(md, { width, color: false });

describe("renderMarkdownAnsi", () => {
  it("wraps paragraphs to the width", () => {
    const out = plain("aaaa bbbb cccc dddd eeee", 14);
    expect(out.split("\n")).toEqual(["aaaa bbbb cccc", "dddd eeee"]);
  });

  it("renders bullets with a hanging indent", () => {
    const out = plain("- first item that wraps onto another line\n- second", 24);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^ {2}• first item/);
    expect(lines[1]).toMatch(/^ {4}\S/); // continuation aligns under the text
    expect(lines.at(-1)).toBe("  • second");
  });

  it("renders numbered lists with the source numbers", () => {
    const out = plain("1. alpha\n2. beta");
    expect(out).toContain("1. alpha");
    expect(out).toContain("2. beta");
  });

  it("renders headings on their own block", () => {
    const out = plain("intro\n\n## Section\n\nbody");
    expect(out.split("\n")).toEqual(["intro", "", "Section", "", "body"]);
  });

  it("keeps fenced code blocks literal and indented, never wrapped", () => {
    const long = "const x = 1; // a line well beyond the wrap width limit here";
    const out = plain(`\`\`\`\n${long}\n\`\`\``, 20);
    expect(out).toContain(`    ${long}`);
  });

  it("strips ** and ` markers in plain mode but keeps the words", () => {
    const out = plain("**Read and probe**: run `npm test` first.");
    expect(out).toBe("Read and probe: run npm test first.");
  });

  it("applies ANSI styling when color is on", () => {
    const out = renderMarkdownAnsi("**bold** and `code`", { width: 40, color: true });
    expect(out).toContain("\u001b[1mbold\u001b[22m");
    expect(out).toContain("\u001b[36mcode\u001b[39m");
  });

  it("leaves unknown syntax literal (fidelity: never mangle)", () => {
    const out = plain("a [link](http://x) and > quote and | table |", 80);
    expect(out).toBe("a [link](http://x) and > quote and | table |");
  });

  it("handles an unclosed fence at EOF", () => {
    const out = plain("```\ndangling");
    expect(out).toContain("    dangling");
  });
});
