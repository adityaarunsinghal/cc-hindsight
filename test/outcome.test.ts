import { describe, expect, it } from "vitest";
import { buildCorpus, type CorpusSession } from "../src/core/dedupe.js";
import { buildOutcome, FINAL_TURNS, OUTCOME_NOTE, TAIL_CHARS } from "../src/core/outcome.js";

function userLine(timestamp: string, text: string): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user", content: text } });
}

function assistantText(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function sidechainAssistant(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

const T1 = "2026-02-01T00:01:00.000Z";
const T2 = "2026-02-01T00:02:00.000Z";
const T3 = "2026-02-01T00:03:00.000Z";
const T4 = "2026-02-01T00:04:00.000Z";
const T5 = "2026-02-01T00:05:00.000Z";

function sessionOf(lines: string[]): CorpusSession {
  const corpus = buildCorpus([{ project: "p", sessionId: "s", sourcePath: "/s", lines }]);
  const session = corpus.sessions[0];
  if (!session) throw new Error("no session built");
  return session;
}

describe("outcome — constants (exported for tests)", () => {
  it("pins the documented bounds", () => {
    expect(FINAL_TURNS).toBe(3);
    expect(TAIL_CHARS).toBe(1600);
    expect(OUTCOME_NOTE).toContain("distillation only");
  });
});

describe("outcome — final_human_turns", () => {
  it("keeps the last 3 deduped human turns, most recent last", () => {
    const outcome = buildOutcome(
      sessionOf([
        userLine(T1, "one"),
        userLine(T2, "two"),
        userLine(T3, "three"),
        userLine(T4, "four"),
      ]),
      [],
    );
    expect(outcome.final_human_turns).toEqual(["two", "three", "four"]);
  });

  it("returns all human turns when fewer than 3 exist", () => {
    const outcome = buildOutcome(
      sessionOf([userLine(T1, "only one"), userLine(T2, "and two")]),
      [],
    );
    expect(outcome.final_human_turns).toEqual(["only one", "and two"]);
  });
});

describe("outcome — final_assistant_tail", () => {
  it("captures the tail of the LAST assistant text turn, bounded and end-anchored", () => {
    const big = `HEAD_MARK${"z".repeat(2000)}TAIL_MARK`;
    const lines = [
      assistantText(T1, "first assistant"),
      userLine(T2, "go"),
      assistantText(T3, big),
    ];
    const outcome = buildOutcome(sessionOf(lines), lines);
    expect(outcome.final_assistant_tail.length).toBe(TAIL_CHARS);
    expect(outcome.final_assistant_tail.endsWith("TAIL_MARK")).toBe(true);
    expect(outcome.final_assistant_tail.includes("HEAD_MARK")).toBe(false);
  });

  it("uses the last assistant text turn, not an earlier one", () => {
    const lines = [
      assistantText(T1, "first assistant"),
      userLine(T2, "go"),
      assistantText(T3, "LAST assistant"),
    ];
    const outcome = buildOutcome(sessionOf(lines), lines);
    expect(outcome.final_assistant_tail).toBe("LAST assistant");
  });

  it("is '' when the session has no assistant text turn", () => {
    const lines = [userLine(T1, "hello"), userLine(T2, "there")];
    const outcome = buildOutcome(sessionOf(lines), lines);
    expect(outcome.final_assistant_tail).toBe("");
  });

  it("ignores sidechain assistant turns (R2 reuse)", () => {
    const lines = [
      assistantText(T4, "REAL final assistant"),
      sidechainAssistant(T5, "SIDECHAIN must not surface"),
      userLine(T5, "ok"),
    ];
    const outcome = buildOutcome(sessionOf(lines), lines);
    expect(outcome.final_assistant_tail).toBe("REAL final assistant");
  });
});
