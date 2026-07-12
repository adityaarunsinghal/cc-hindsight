import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { hint, table } from "../src/ui/style.js";

describe("table()", () => {
  it("pads columns to the max width per column", () => {
    const out = table([
      ["a", "long-cell", "x"],
      ["longer-a", "b", "y"],
    ]);
    const lines = out.split("\n");
    expect(lines).toEqual(["a         long-cell  x", "longer-a  b          y"]);
    // Column 2 starts at the same offset on every line.
    expect(lines[0]?.indexOf("long-cell")).toBe(lines[1]?.indexOf("b"));
  });

  it("renders a header with a dim separator line underneath", () => {
    const out = stripVTControlCharacters(table([["alpha", "1"]], { header: ["name", "count"] }));
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("name   count");
    expect(lines[1]).toBe("-----  -----");
    expect(lines[2]).toBe("alpha  1");
  });

  it("works without a header", () => {
    const out = table([["only", "row"]]);
    expect(out).toBe("only  row");
    expect(out).not.toContain("--");
  });

  it("returns empty string for no rows", () => {
    expect(table([])).toBe("");
  });
});

describe("hint()", () => {
  it("formats the funnel hint", () => {
    expect(stripVTControlCharacters(hint("cc-hindsight export"))).toBe(
      "→ next: cc-hindsight export",
    );
  });
});
