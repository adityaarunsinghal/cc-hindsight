import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_BUDGET,
  MIN_INPUT_BUDGET,
  middleCut,
  resolveInputBudget,
  resolveTimeoutMs,
  resolveTruncatePolicy,
} from "../src/core/budget.js";

describe("resolveInputBudget", () => {
  it("defaults when absent, invalid, or below the floor", () => {
    expect(resolveInputBudget(undefined)).toBe(DEFAULT_INPUT_BUDGET);
    expect(resolveInputBudget("abc")).toBe(DEFAULT_INPUT_BUDGET);
    expect(resolveInputBudget(String(MIN_INPUT_BUDGET - 1))).toBe(DEFAULT_INPUT_BUDGET);
    expect(resolveInputBudget("-5")).toBe(DEFAULT_INPUT_BUDGET);
  });

  it("accepts a valid override", () => {
    expect(resolveInputBudget("250000")).toBe(250_000);
  });
});

describe("resolveTruncatePolicy", () => {
  it("is 'never' unless explicitly 'extreme'", () => {
    expect(resolveTruncatePolicy(undefined)).toBe("never");
    expect(resolveTruncatePolicy("never")).toBe("never");
    expect(resolveTruncatePolicy("nonsense")).toBe("never");
    expect(resolveTruncatePolicy("extreme")).toBe("extreme");
  });
});

describe("resolveTimeoutMs", () => {
  it("converts seconds to ms, rejecting invalid/absent", () => {
    expect(resolveTimeoutMs(undefined)).toBeUndefined();
    expect(resolveTimeoutMs("0")).toBeUndefined();
    expect(resolveTimeoutMs("-3")).toBeUndefined();
    expect(resolveTimeoutMs("abc")).toBeUndefined();
    expect(resolveTimeoutMs("120")).toBe(120_000);
  });
});

describe("middleCut", () => {
  it("passes content through untouched when it fits", () => {
    expect(middleCut("hello", 100)).toEqual({ text: "hello", dropped: 0 });
  });

  it("cuts to exactly the budget with head+tail and an EXACT dropped-count", () => {
    const content = `HEAD${"x".repeat(100_000)}TAIL`;
    for (const budget of [1_000, 9_999, 10_000, 12_345]) {
      const { text, dropped } = middleCut(content, budget);
      expect(text.length).toBe(budget);
      expect(text.startsWith("HEAD")).toBe(true);
      expect(text.endsWith("TAIL")).toBe(true);
      // The reported dropped-count equals the bytes actually removed.
      const stated = Number(/truncated (\d+) characters/.exec(text)?.[1]);
      expect(stated).toBe(dropped);
      const markerLen =
        `\n\n[... cc-hindsight truncated ${stated} characters from the middle of this session ...]\n\n`
          .length;
      expect(content.length - (budget - markerLen)).toBe(dropped);
    }
  });

  it("guards a budget smaller than the marker (returns exactly budget chars)", () => {
    const { text, dropped } = middleCut("z".repeat(1_000), 20);
    expect(text.length).toBe(20);
    expect(dropped).toBe(1_000);
  });
});
