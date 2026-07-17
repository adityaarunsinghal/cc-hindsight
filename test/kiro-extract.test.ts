import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KiroSessionMeta } from "../src/sources/kiro/discover.js";
import {
  classifyKiroLines,
  classifyKiroSession,
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

describe("kiro extract — K11 non-text Prompt blocks", () => {
  it("renders an image block as the R11-parity placeholder", () => {
    const { messages } = extractKiroMessages(lines("k11-unknown-block.jsonl"));
    // The placeholder joins the surviving text piece (blank-line separated).
    expect(messages.map((m) => m.text)).toEqual(["look at this screenshot\n\n[image pasted]"]);
  });

  it("records an observable Drop for an unknown block kind (never silent)", () => {
    const { drops } = extractKiroMessages(lines("k11-unknown-block.jsonl"));
    const k11 = drops.filter((d) => d.reason.startsWith("K11"));
    expect(k11.length).toBe(1);
    expect(k11[0]?.reason).toBe("K11: unknown block kind (hologram)");
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

  it("records a Drop for a snapshot-only prompt (never silently absent)", () => {
    const { messages, drops } = extractKiroMessages(lines("k12-snapshot-only.jsonl"));
    // Only the live prompt is extracted…
    expect(messages.map((m) => m.text)).toEqual(["live prompt"]);
    // …the snapshot item that duplicates it records nothing, and the
    // snapshot-ONLY item (e.g. /chat load-imported pre-compaction history)
    // is visible in the drop ledger.
    const k12 = drops.filter((d) => d.reason === "K12: snapshot-only prompt");
    expect(k12.length).toBe(1);
    expect(k12[0]?.snippet).toContain("imported pre-compaction prompt");
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
    "k11-unknown-block.jsonl",
    "k12-boundaries.jsonl",
    "k12-snapshot-only.jsonl",
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

describe("kiro extract — K2 hybrid precedence (unit)", () => {
  it("a parent-linked (rewind/subagent) session WITH .history is INCLUDED — step 1 beats step 2", () => {
    const hybrid: KiroSessionMeta = { hasHistory: true, parentSessionId: "parent-uuid" };
    const verdict = classifyKiroSession(hybrid, "[AGENT SYSTEM PROMPT] You are a spawned worker.");
    expect(verdict.include).toBe(true);
    expect(verdict.reason).toContain(".history present");
  });

  it("the same session WITHOUT .history is excluded as a spawned child", () => {
    const child: KiroSessionMeta = { hasHistory: false, parentSessionId: "parent-uuid" };
    expect(
      classifyKiroSession(child, "[AGENT SYSTEM PROMPT] You are a spawned worker.").include,
    ).toBe(false);
  });
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
