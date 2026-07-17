import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { banner, fail, hint, ok, skip, table } from "../src/ui/style.js";

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

  it("caps the table at maxWidth by shrinking the widest columns with an ellipsis", () => {
    const out = table(
      [
        ["slug-one", "a very long title that dominates the table by far", "ok"],
        ["slug-two", "short", "ok"],
      ],
      { header: ["Slug", "Title", "St"], maxWidth: 40 },
    );
    for (const line of stripVTControlCharacters(out).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // Only the dominating column was cut; narrow columns survive whole.
    expect(stripVTControlCharacters(out)).toContain("slug-one");
    expect(stripVTControlCharacters(out)).toContain("…");
  });

  it("truncates styled cells ANSI-safely (reset appended, visible width exact)", () => {
    const styled = `\u001b[36m${"x".repeat(30)}\u001b[39m`;
    const out = table([[styled, "b"]], { maxWidth: 20 });
    const firstCell = out.split("  ")[0] ?? "";
    expect(stripVTControlCharacters(firstCell).length).toBeLessThanOrEqual(18);
    expect(stripVTControlCharacters(firstCell).endsWith("…")).toBe(true);
    expect(firstCell.endsWith("\u001b[0m")).toBe(true); // style can't bleed past the cut
  });

  it("does not cap when maxWidth is absent and stdout is not a TTY (pipes keep full content)", () => {
    const wide = "w".repeat(500);
    expect(table([[wide]])).toBe(wide);
  });
});

describe("hint()", () => {
  it("formats the funnel hint", () => {
    expect(stripVTControlCharacters(hint("cc-hindsight export"))).toBe(
      "→ next: cc-hindsight export",
    );
  });
});

describe("banner()", () => {
  it("renders label, rule, and right-hand annotation", () => {
    const plain = stripVTControlCharacters(banner("digest", "5 sessions"));
    expect(plain).toMatch(/^── digest ─+ 5 sessions$/);
  });

  it("omits the right column when not given", () => {
    const plain = stripVTControlCharacters(banner("cluster"));
    expect(plain).toMatch(/^── cluster ─+$/);
    expect(plain).not.toContain("  ");
  });

  it("aligns the right column across labels of different lengths", () => {
    const a = stripVTControlCharacters(banner("digest", "R"));
    const b = stripVTControlCharacters(banner("author", "R"));
    expect(a.indexOf(" R")).toBe(b.indexOf(" R"));
  });
});

describe("status glyphs", () => {
  it("prefix the line with the matching glyph", () => {
    expect(stripVTControlCharacters(ok("done"))).toBe("✔ done");
    expect(stripVTControlCharacters(fail("broke"))).toBe("✗ broke");
    expect(stripVTControlCharacters(skip("cut"))).toBe("⤬ cut");
  });
});
