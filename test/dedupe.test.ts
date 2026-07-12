import { describe, expect, it } from "vitest";
import { buildCorpus, type DedupeInput } from "../src/core/dedupe.js";

/** A minimal human `user` entry JSONL line. */
function userLine(timestamp: string, text: string): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user", content: text } });
}

/** An assistant line — never human input; must be ignored by extraction. */
function assistantLine(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-01T00:01:00.000Z";
const T3 = "2026-01-01T01:00:00.000Z";
const T4 = "2026-01-01T01:01:00.000Z";

/**
 * Two sessions: A is the original; B is a fork/resume that copied A verbatim,
 * then added a genuinely new message and a deliberate re-send of A's first
 * message at a NEW timestamp.
 */
function forkPair(): DedupeInput[] {
  const sessionA: DedupeInput = {
    project: "proj",
    sessionId: "sess-a",
    sourcePath: "/tmp/sess-a.jsonl",
    lines: [userLine(T1, "hello"), assistantLine(T2, "hi"), userLine(T2, "world")],
  };
  const sessionB: DedupeInput = {
    project: "proj",
    sessionId: "sess-b",
    sourcePath: "/tmp/sess-b.jsonl",
    lines: [
      userLine(T1, "hello"), // fork copy of A's first message → drops
      userLine(T2, "world"), // fork copy of A's second message → drops
      userLine(T3, "brand new instruction"), // genuinely new → survives
      userLine(T4, "hello"), // deliberate re-send (new ts) → survives
    ],
  };
  return [sessionA, sessionB];
}

describe("buildCorpus — R8 cross-file dedupe", () => {
  it("attributes each (timestamp,text) to the earliest session; fork copies drop", () => {
    const corpus = buildCorpus(forkPair());
    const a = corpus.sessions.find((s) => s.sessionId === "sess-a");
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");

    // A owns everything it typed.
    expect(a?.messages.map((m) => m.text)).toEqual(["hello", "world"]);
    // B's two fork copies are gone; only the new one and the re-send remain.
    expect(b?.messages.map((m) => m.text)).toEqual(["brand new instruction", "hello"]);
    expect(corpus.duplicatesDropped).toBe(2);
    expect(b?.dedupeDropped).toBe(2);
    expect(a?.dedupeDropped).toBe(0);
  });

  it("keeps a deliberate re-send (same text, new timestamp) alive in both sessions", () => {
    const corpus = buildCorpus(forkPair());
    const a = corpus.sessions.find((s) => s.sessionId === "sess-a");
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");
    // "hello" survives in A (at T1) AND in B (re-sent at T4) — distinct keys.
    expect(a?.messages.some((m) => m.text === "hello" && m.timestamp === T1)).toBe(true);
    expect(b?.messages.some((m) => m.text === "hello" && m.timestamp === T4)).toBe(true);
  });

  it("re-indexes surviving messages from 0 per session (the alignment key)", () => {
    const corpus = buildCorpus(forkPair());
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");
    // Even though B's survivors were the 3rd and 4th entries in the file, their
    // post-dedupe indices are a dense 0,1 — this is what Task 5 aligns against.
    expect(b?.messages.map((m) => m.index)).toEqual([0, 1]);
    const a = corpus.sessions.find((s) => s.sessionId === "sess-a");
    expect(a?.messages.map((m) => m.index)).toEqual([0, 1]);
  });

  it("reports first/last timestamps of the surviving messages", () => {
    const corpus = buildCorpus(forkPair());
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");
    expect(b?.firstTs).toBe(T3);
    expect(b?.lastTs).toBe(T4);
  });

  it("orders sessions by earliest message timestamp, then sessionId", () => {
    const inputs: DedupeInput[] = [
      { project: "p", sessionId: "z-late", sourcePath: "/z", lines: [userLine(T3, "c")] },
      { project: "p", sessionId: "a-early", sourcePath: "/a", lines: [userLine(T1, "a")] },
      { project: "p", sessionId: "m-mid", sourcePath: "/m", lines: [userLine(T2, "b")] },
    ];
    const corpus = buildCorpus(inputs);
    expect(corpus.sessions.map((s) => s.sessionId)).toEqual(["a-early", "m-mid", "z-late"]);
  });

  it("breaks earliest-timestamp ties on sessionId lexicographically", () => {
    const inputs: DedupeInput[] = [
      { project: "p", sessionId: "sess-b", sourcePath: "/b", lines: [userLine(T1, "shared")] },
      { project: "p", sessionId: "sess-a", sourcePath: "/a", lines: [userLine(T1, "shared")] },
    ];
    const corpus = buildCorpus(inputs);
    // sess-a sorts first, so it OWNS the shared key; sess-b drops its copy.
    expect(corpus.sessions.map((s) => s.sessionId)).toEqual(["sess-a", "sess-b"]);
    const a = corpus.sessions.find((s) => s.sessionId === "sess-a");
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");
    expect(a?.messages.map((m) => m.text)).toEqual(["shared"]);
    expect(b?.messages).toEqual([]);
  });

  it("keeps a zero-surviving-message session in the corpus with empty messages", () => {
    const inputs: DedupeInput[] = [
      {
        project: "p",
        sessionId: "empty",
        sourcePath: "/e",
        lines: [userLine(T1, "<system-reminder>noise</system-reminder>")],
      },
    ];
    const corpus = buildCorpus(inputs);
    expect(corpus.sessions).toHaveLength(1);
    expect(corpus.sessions[0]?.messages).toEqual([]);
    expect(corpus.sessions[0]?.firstTs).toBe("");
    expect(corpus.sessions[0]?.lastTs).toBe("");
  });

  it("is deterministic under any permutation of the input order", () => {
    const forward = buildCorpus(forkPair());
    const reversed = buildCorpus([...forkPair()].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
