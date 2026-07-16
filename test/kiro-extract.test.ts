import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KiroSessionMeta } from "../src/sources/kiro/discover.js";
import {
  classifyKiroLines,
  extractKiroMessages,
  kiroTimeline,
} from "../src/sources/kiro/extract.js";

const FIX = path.join(import.meta.dirname, "fixtures", "kiro-extract");
function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), "utf8").split(/\r?\n/);
}

describe("kiro extract — K1/K4 admission", () => {
  it("extracts only Prompt text, normalizing unix-seconds to ISO", () => {
    const { messages, badLines } = extractKiroMessages(lines("k1-prompt.jsonl"));
    expect(messages).toEqual([{ timestamp: "2026-07-14T03:33:20.000Z", text: "do the thing" }]);
    // AssistantMessage + ToolResults are never human candidates.
    expect(badLines).toBe(0);
  });

  it("tolerates a Prompt with no timestamp (emits '')", () => {
    const { messages } = extractKiroMessages(lines("k1-no-timestamp.jsonl"));
    expect(messages).toEqual([{ timestamp: "", text: "no timestamp here" }]);
  });

  it("counts a corrupt line in badLines without aborting", () => {
    const { messages, badLines } = extractKiroMessages(lines("k1-badline.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["good line"]);
    expect(badLines).toBe(1);
  });
});

describe("kiro extract — K6 machine-piece drops", () => {
  it("drops leading-<, bracket markers, and harness nudges; keeps real text", () => {
    const { messages, drops } = extractKiroMessages(lines("k6-machine.jsonl"));
    // Only the genuine human instruction survives.
    expect(messages.map((m) => m.text)).toEqual(["real human instruction here"]);
    // Each machine piece is an observable Drop (fidelity contract).
    const reasons = drops.map((d) => d.reason);
    expect(reasons).toContain("K6: machine block (leading <)");
    expect(reasons).toContain("K6: bracket marker");
    expect(reasons).toContain("K6: harness nudge");
  });

  it("never reads meta.additionalContext as human text", () => {
    const { messages } = extractKiroMessages(lines("k6-machine.jsonl"));
    for (const m of messages) expect(m.text).not.toContain("machine ctx");
  });
});

describe("kiro extract — K12 boundaries & snapshot", () => {
  it("ignores Clear/Compaction as human text; snapshot is not re-extracted", () => {
    const { messages } = extractKiroMessages(lines("k12-boundaries.jsonl"));
    // Two real prompts; the Compaction snapshot's duplicate of "first request"
    // is NOT emitted again (it would double-count).
    expect(messages.map((m) => m.text)).toEqual(["first request", "second request after clear"]);
  });

  it("emits boundary timeline events for Clear and Compaction", () => {
    const timeline = kiroTimeline(lines("k12-boundaries.jsonl"));
    const kinds = timeline.map((e) => e.kind);
    expect(kinds.filter((k) => k === "boundary").length).toBe(2);
    // A human turn precedes the first boundary; another follows it.
    expect(kinds).toEqual(["human", "assistant", "boundary", "human", "boundary"]);
  });
});

describe("kiro extract — K5 negative (tool cancel is machine text)", () => {
  it("never extracts cancelled/rejected tool text; the human follow-up is its own Prompt", () => {
    const { messages } = extractKiroMessages(lines("k5-cancelled-tool.jsonl"));
    expect(messages.map((m) => m.text)).toEqual(["run the deploy", "actually do it differently"]);
    for (const m of messages) expect(m.text).not.toContain("cancelled by the user");
  });
});

describe("kiro extract — SessionSource law (extract ↔ timeline agreement)", () => {
  // Every extracted human message must appear as a `human` timeline event with
  // identical (timestamp, text), in file order — the alignment invariant.
  for (const fixture of [
    "k1-prompt.jsonl",
    "k6-machine.jsonl",
    "k12-boundaries.jsonl",
    "k5-cancelled-tool.jsonl",
  ]) {
    it(`holds for ${fixture}`, () => {
      const msgs = extractKiroMessages(lines(fixture)).messages;
      const humanEvents = kiroTimeline(lines(fixture)).filter((e) => e.kind === "human");
      expect(humanEvents.map((e) => ({ timestamp: e.timestamp, text: e.text }))).toEqual(
        msgs.map((m) => ({ timestamp: m.timestamp, text: m.text })),
      );
    });
  }
});

describe("kiro extract — K13 self-recognition (classify)", () => {
  const noHistoryMeta: KiroSessionMeta = { hasHistory: false };
  it("excludes a cc-hindsight distill session even with no other markers", () => {
    const verdict = classifyKiroLines(noHistoryMeta, lines("k13-self.jsonl"));
    expect(verdict.include).toBe(false);
    expect(verdict.reason).toContain("K13");
  });

  it("a .history session is still included over everything except K13", () => {
    // K13 wins even when .history exists (self-recognition is absolute).
    const withHistory: KiroSessionMeta = { hasHistory: true };
    expect(classifyKiroLines(withHistory, lines("k13-self.jsonl")).include).toBe(false);
    // But a normal prompt with .history is included.
    expect(classifyKiroLines(withHistory, lines("k1-prompt.jsonl")).include).toBe(true);
  });
});
