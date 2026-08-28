import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KiroSessionMeta } from "../src/sources/kiro/discover.js";
import {
  classifyKiroV3Lines,
  classifyKiroV3Session,
  detectKiroFormat,
  extractKiroV3Messages,
  kiroV3Timeline,
} from "../src/sources/kiro/extract-v3.js";

const FIX = path.join(import.meta.dirname, "fixtures", "kiro-v3");
function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), "utf8").split(/\r?\n/);
}
function v2Lines(name: string): string[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, "fixtures", "kiro-extract", name), "utf8")
    .split(/\r?\n/);
}

describe("kiro v3 extract: user admission", () => {
  it("extracts only `user` text with the in-band ISO timestamp", () => {
    const { messages, badLines } = extractKiroV3Messages(lines("user-assistant.jsonl"));
    expect(messages).toEqual([{ timestamp: "2026-08-01T10:00:01.000Z", text: "do the thing" }]);
    // assistant (Say/Reasoning), tool_call/result, session_start, turn_end are machine.
    expect(badLines).toBe(0);
  });

  it("records an empty user body as an observable Drop, never silently", () => {
    const { messages, drops } = extractKiroV3Messages(lines("empty-user.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["real message"]);
    expect(drops.map((d) => d.reason)).toContain("V3: empty user content");
  });

  it("counts a corrupt line in badLines without aborting", () => {
    const { messages, badLines } = extractKiroV3Messages(lines("badline.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["good line"]);
    expect(badLines).toBe(1);
  });
});

describe("kiro v3 timeline: human + assistant Say, reasoning omitted", () => {
  it("emits a human turn and an assistant Say turn, skipping Reasoning and tools", () => {
    const timeline = kiroV3Timeline(lines("user-assistant.jsonl"));
    expect(timeline.map((e) => e.kind)).toEqual(["human", "assistant"]);
    expect(timeline.map((e) => e.text)).toEqual(["do the thing", "done, here is the result"]);
  });
});

describe("kiro v3: SessionSource law (extract ↔ timeline agreement)", () => {
  for (const fixture of [
    "user-assistant.jsonl",
    "empty-user.jsonl",
    "badline.jsonl",
    "classify-plain.jsonl",
  ]) {
    it(`holds for ${fixture}`, () => {
      const msgs = extractKiroV3Messages(lines(fixture)).messages;
      const human = kiroV3Timeline(lines(fixture)).filter((e) => e.kind === "human");
      expect(human.map((e) => ({ timestamp: e.timestamp, text: e.text }))).toEqual(
        msgs.map((m) => ({ timestamp: m.timestamp, text: m.text })),
      );
    });
  }
});

describe("detectKiroFormat: v2 vs v3 sniffing", () => {
  it("classifies a payload-shaped line as v3", () => {
    expect(detectKiroFormat(lines("user-assistant.jsonl"))).toBe("v3");
  });
  it("classifies a {version,kind,data} line as v2", () => {
    expect(detectKiroFormat(v2Lines("k1-prompt.jsonl"))).toBe("v2");
  });
  it("defaults to v2 on an empty/unparseable file (harmless)", () => {
    expect(detectKiroFormat(["", "   ", "{not json"])).toBe("v2");
  });
});

describe("kiro v3 classify: recall-oriented precedence", () => {
  const noHistory: KiroSessionMeta = { hasHistory: false };

  it("EXCLUDES a cc-hindsight distill session (K13 self-recognition)", () => {
    const verdict = classifyKiroV3Lines(noHistory, lines("classify-distill.jsonl"));
    expect(verdict.include).toBe(false);
    expect(verdict.reason).toContain("K13");
  });

  it("K13 is absolute: a distill session is excluded even with .history", () => {
    const withHistory: KiroSessionMeta = { hasHistory: true };
    expect(classifyKiroV3Lines(withHistory, lines("classify-distill.jsonl")).include).toBe(false);
  });

  it("INCLUDES a session with .history over an automation-marker first prompt", () => {
    const withHistory: KiroSessionMeta = { hasHistory: true };
    const verdict = classifyKiroV3Lines(withHistory, lines("classify-agent-prompt.jsonl"));
    expect(verdict.include).toBe(true);
    expect(verdict.reason).toContain(".history present");
  });

  it("EXCLUDES an [AGENT SYSTEM PROMPT] first prompt with no .history", () => {
    expect(classifyKiroV3Lines(noHistory, lines("classify-agent-prompt.jsonl")).include).toBe(
      false,
    );
  });

  it("INCLUDES a plain interactive session (recall default) with no .history", () => {
    const verdict = classifyKiroV3Lines(noHistory, lines("classify-plain.jsonl"));
    expect(verdict.include).toBe(true);
    expect(verdict.reason).toContain("recall-oriented default");
  });

  it("does NOT exclude on parentSessionId: a top-level v3 fork is human", () => {
    // Unlike v2 K2 step 2, a parent-linked v3 session with a plain prompt is kept
    // (true subagents live under sub-executions/ and are never enumerated).
    const fork: KiroSessionMeta = { hasHistory: false, parentSessionId: "sess_parent" };
    expect(classifyKiroV3Session(fork, "continue from the fork please").include).toBe(true);
  });
});
