import { describe, expect, it } from "vitest";
import { stripFence } from "../src/runners/shared.js";

/**
 * `stripFence` is the last line of defense on the schema-in-prompt path: when
 * the CLI cannot validate server-side (no `--json-schema`, or the kiro runner,
 * which never has one), the model's raw text is all we get. A fence it fails to
 * strip becomes a JSON parse error, which burns the one corrective retry and can
 * fail the stage outright. Verified against the live CLI on that path: the model
 * really does answer with a ```json fence even when told "respond ONLY with
 * JSON", so the neighboring shapes below are the ones worth tolerating.
 */
const BODY = '{"ok":true,"n":1}';
const parses = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

describe("stripFence — shapes already handled (must not regress)", () => {
  it("passes bare JSON through untouched", () => {
    expect(stripFence(BODY)).toBe(BODY);
  });

  it("strips a ```json fence", () => {
    expect(stripFence(`\`\`\`json\n${BODY}\n\`\`\``)).toBe(BODY);
  });

  it("strips an unlabeled ``` fence", () => {
    expect(stripFence(`\`\`\`\n${BODY}\n\`\`\``)).toBe(BODY);
  });

  it("tolerates surrounding whitespace", () => {
    expect(stripFence(`\n  \`\`\`json \n${BODY}\n\`\`\` \n`)).toBe(BODY);
  });
});

describe("stripFence — shapes that used to survive as unparseable text", () => {
  it("strips a fence followed by a sign-off", () => {
    const out = stripFence(`\`\`\`json\n${BODY}\n\`\`\`\n\nHope that helps!`);
    expect(parses(out)).toBe(true);
    expect(JSON.parse(out)).toEqual({ ok: true, n: 1 });
  });

  it("strips a fence preceded by a preamble", () => {
    const out = stripFence(`Here you go:\n\n\`\`\`json\n${BODY}\n\`\`\``);
    expect(parses(out)).toBe(true);
    expect(JSON.parse(out)).toEqual({ ok: true, n: 1 });
  });

  it("strips a fence wrapped in prose on BOTH sides", () => {
    const out = stripFence(`Sure thing.\n\n\`\`\`json\n${BODY}\n\`\`\`\n\nLet me know.`);
    expect(parses(out)).toBe(true);
  });

  it("handles an uppercase ```JSON language tag", () => {
    // The old pattern matched only lowercase `json`, so `JSON` was captured as
    // part of the BODY and the result began with the literal text "JSON".
    const out = stripFence(`\`\`\`JSON\n${BODY}\n\`\`\``);
    expect(parses(out)).toBe(true);
    expect(out).not.toContain("JSON\n");
  });

  it("takes the FIRST fenced block when the model emits two", () => {
    const out = stripFence(`\`\`\`json\n${BODY}\n\`\`\`\n\n\`\`\`json\n{"other":2}\n\`\`\``);
    expect(JSON.parse(out)).toEqual({ ok: true, n: 1 });
  });
});

describe("stripFence — must not corrupt non-fenced input", () => {
  it("leaves prose with backticks alone rather than inventing a body", () => {
    const prose = "I cannot do that because `foo` is undefined.";
    expect(stripFence(prose)).toBe(prose);
  });

  it("leaves an unterminated fence as-is (no silent half-parse)", () => {
    const broken = `\`\`\`json\n${BODY}`;
    // Nothing valid to extract: return the text so the caller reports a real
    // parse error with the actual content in the snippet.
    expect(stripFence(broken)).toContain(BODY);
  });

  it("returns an empty string unchanged", () => {
    expect(stripFence("")).toBe("");
  });

  it("does not treat inline triple-backticks mid-sentence as a block", () => {
    const s = 'the value is {"ok":true} (no fence here)';
    expect(stripFence(s)).toBe(s);
  });
});
