import { describe, expect, it } from "vitest";
import {
  type AnaphoraRecord,
  buildAnaphora,
  isShortTurn,
  SHORT_TURN_MAX_WORDS,
  TAIL_CHARS,
  wordCount,
} from "../src/core/anaphora.js";
import { buildCorpus, type CorpusSession, type DedupeInput } from "../src/core/dedupe.js";
import { extractMessages, extractTimeline } from "../src/core/extract.js";
import { renderExport } from "../src/core/render.js";

// ---- JSONL line builders (synthetic; never the real ~/.claude) ----------

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

/** An assistant ExitPlanMode turn, optionally preceded by intro text. */
function planLine(timestamp: string, plan: string, lead?: string): string {
  const content: unknown[] = [];
  if (lead !== undefined) content.push({ type: "text", text: lead });
  content.push({ type: "tool_use", name: "ExitPlanMode", input: { plan } });
  return JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content } });
}

/** An assistant AskUserQuestion turn; `questions` shape is passed through verbatim. */
function questionLine(timestamp: string, questions: unknown[], lead?: string): string {
  const content: unknown[] = [];
  if (lead !== undefined) content.push({ type: "text", text: lead });
  content.push({ type: "tool_use", name: "AskUserQuestion", input: { questions } });
  return JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content } });
}

function sidechainAssistant(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const T4 = "2026-01-01T00:04:00.000Z";
const T5 = "2026-01-01T00:05:00.000Z";

/** Build the single session's corpus entry from raw lines. */
function sessionOf(lines: string[], sessionId = "s"): CorpusSession {
  const corpus = buildCorpus([
    { project: "p", sessionId, sourcePath: `/${sessionId}`, extracted: extractMessages(lines) },
  ]);
  const session = corpus.sessions.find((s) => s.sessionId === sessionId);
  if (!session) throw new Error("no session built");
  return session;
}

/** Run the anaphora pass over one synthetic session (timeline via the claude source). */
function anaphoraFor(lines: string[]): AnaphoraRecord[] {
  return buildAnaphora(sessionOf(lines), extractTimeline(lines));
}

// ---- short-turn detection ---------------------------------------------------

describe("anaphora — short-turn detection (recall-oriented)", () => {
  it("counts whitespace-split tokens", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
    expect(wordCount("one")).toBe(1);
    expect(wordCount("  two   words  ")).toBe(2);
  });

  it("attaches at the 15-word boundary but not at 16 words", () => {
    const w15 =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const w16 = `${w15} sixteen`;
    expect(SHORT_TURN_MAX_WORDS).toBe(15);
    expect(wordCount(w15)).toBe(15);
    expect(isShortTurn(w15)).toBe(true);
    expect(wordCount(w16)).toBe(16);
    expect(isShortTurn(w16)).toBe(false);

    const records = anaphoraFor([userLine(T1, w15), userLine(T2, w16)]);
    expect(records.map((r) => r.human_text)).toEqual([w15]);
  });

  it("emits a record for a first message with neither antecedent nor decision", () => {
    const records = anaphoraFor([userLine(T1, "just start")]);
    expect(records).toHaveLength(1);
    expect(records[0]?.antecedent).toBeNull();
    expect(records[0]?.decision_kind).toBeNull();
    expect(records[0]?.decision_text).toBeNull();
  });
});

// ---- antecedent capture -----------------------------------------------------

describe("anaphora — antecedent (immediately preceding assistant text)", () => {
  it("keeps a short antecedent whole", () => {
    const records = anaphoraFor([assistantText(T1, "short answer"), userLine(T2, "yes")]);
    expect(records[0]?.antecedent).toBe("short answer");
  });

  it("keeps only the TAIL of a long antecedent, cut from the END", () => {
    const big = `HEAD_MARK${"y".repeat(2000)}TAIL_MARK`;
    const records = anaphoraFor([assistantText(T1, big), userLine(T2, "yes")]);
    const antecedent = records[0]?.antecedent ?? "";
    expect(antecedent.length).toBe(TAIL_CHARS);
    expect(antecedent.endsWith("TAIL_MARK")).toBe(true);
    expect(antecedent.includes("HEAD_MARK")).toBe(false);
  });

  it("does NOT treat a sidechain assistant turn as an antecedent (R2 reuse)", () => {
    const records = anaphoraFor([
      assistantText(T1, "REAL antecedent"),
      sidechainAssistant(T2, "SIDECHAIN text that must never surface"),
      userLine(T3, "yes"),
    ]);
    expect(records[0]?.antecedent).toBe("REAL antecedent");
    expect(records[0]?.antecedent).not.toContain("SIDECHAIN");
  });
});

// ---- plan / question surfacing ---------------------------------------------

describe("anaphora — pending decision surfacing", () => {
  it("surfaces an ExitPlanMode plan a bare 'yes' approved", () => {
    const records = anaphoraFor([
      userLine(T1, "plan it"),
      planLine(T2, "## PLAN\n1. do the thing", "Proposing a plan."),
      userLine(T3, "yes"),
    ]);
    const yes = records.find((r) => r.human_text === "yes");
    expect(yes?.decision_kind).toBe("plan");
    expect(yes?.decision_text).toContain("## PLAN");
    expect(yes?.antecedent).toBe("Proposing a plan.");
  });

  it("surfaces an AskUserQuestion with object options compactly", () => {
    const records = anaphoraFor([
      userLine(T1, "set it up"),
      questionLine(
        T2,
        [{ question: "Which DB?", options: [{ label: "PostgreSQL" }, { label: "MySQL" }] }],
        "A quick question:",
      ),
      userLine(T3, "option 2"),
    ]);
    const answer = records.find((r) => r.human_text === "option 2");
    expect(answer?.decision_kind).toBe("question");
    expect(answer?.decision_text).toBe("Which DB? [PostgreSQL, MySQL]");
    expect(answer?.antecedent).toBe("A quick question:");
  });

  it("tolerates AskUserQuestion options given as plain strings", () => {
    const records = anaphoraFor([
      questionLine(T1, [{ question: "Pick one", options: ["A", "B", "C"] }]),
      userLine(T2, "option 2"),
    ]);
    const answer = records.find((r) => r.human_text === "option 2");
    expect(answer?.decision_kind).toBe("question");
    expect(answer?.decision_text).toBe("Pick one [A, B, C]");
  });

  it("marks a multi-select question so a terse pick isn't misread", () => {
    const records = anaphoraFor([
      questionLine(T1, [
        { question: "Which features?", options: ["Auth", "Billing"], multiSelect: true },
      ]),
      userLine(T2, "both"),
    ]);
    const answer = records.find((r) => r.human_text === "both");
    expect(answer?.decision_kind).toBe("question");
    expect(answer?.decision_text).toBe("Which features? [Auth, Billing] (multi-select)");
  });

  it("scopes the pending window: a plan issued before the previous human turn is NOT pending", () => {
    const records = anaphoraFor([
      userLine(T1, "first request here"),
      planLine(T2, "## OLD PLAN", "old planning"),
      userLine(T3, "middle turn here"),
      assistantText(T4, "some later reply"),
      userLine(T5, "yes"),
    ]);
    // The plan is pending for the turn that immediately followed it...
    const middle = records.find((r) => r.human_text === "middle turn here");
    expect(middle?.decision_kind).toBe("plan");
    // ...but NOT for "yes", whose window (middle-turn → yes) contains no plan.
    const yes = records.find((r) => r.human_text === "yes");
    expect(yes?.decision_kind).toBeNull();
    expect(yes?.decision_text).toBeNull();
  });
});

// ---- index alignment against the rendered export (constraint 2) -------------

/** Parse renderExport markdown into ordered { timestamp, text } message blocks. */
function parseRenderedBlocks(markdown: string): { timestamp: string; text: string }[] {
  const parts = markdown.split("\n### ").slice(1); // drop the header segment
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const timestamp = part.slice(0, nl);
    const body = part
      .slice(nl + 1)
      .replace(/^\n/, "")
      .replace(/\n$/, "");
    return { timestamp, text: body };
  });
}

describe("anaphora — index alignment with rendered export", () => {
  it("every record.index maps to the correct rendered '### <ts>' heading + text", () => {
    const lines = [
      userLine(T0, "kick things off"),
      assistantText(T1, "here is a proposal"),
      userLine(T2, "yes"),
      userLine(
        T3,
        "This turn is far too long to be short so it will never get a record here today because it clearly exceeds fifteen words",
      ),
      userLine(T4, "do it"),
    ];
    const session = sessionOf(lines);
    const records = buildAnaphora(session, extractTimeline(lines));
    const blocks = parseRenderedBlocks(renderExport(session));

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const block = blocks[record.index];
      expect(block?.timestamp).toBe(record.timestamp);
      expect(block?.text).toBe(record.human_text);
    }
  });

  it("aligns records to post-dedupe indices and drops fork-copy ownership", () => {
    const linesA = [assistantText(T0, "context essay"), userLine(T1, "yes")];
    const linesB = [
      assistantText(T0, "context essay"), // assistant turns are not deduped
      userLine(T1, "yes"), // fork copy of A's owned turn → no record here
      userLine(T2, "new short turn"), // genuinely new → owned + recorded
    ];
    const sessionA: DedupeInput = {
      project: "p",
      sessionId: "sess-a",
      sourcePath: "/a",
      extracted: extractMessages(linesA),
    };
    const sessionB: DedupeInput = {
      project: "p",
      sessionId: "sess-b",
      sourcePath: "/b",
      extracted: extractMessages(linesB),
    };
    const corpus = buildCorpus([sessionA, sessionB]);
    const a = corpus.sessions.find((s) => s.sessionId === "sess-a");
    const b = corpus.sessions.find((s) => s.sessionId === "sess-b");
    if (!a || !b) throw new Error("sessions missing");

    const aRecords = buildAnaphora(a, extractTimeline(linesA));
    const bRecords = buildAnaphora(b, extractTimeline(linesB));

    // A owns "yes" at post-dedupe index 0, with the essay as antecedent.
    expect(aRecords.map((r) => r.human_text)).toEqual(["yes"]);
    expect(aRecords[0]?.index).toBe(0);
    expect(aRecords[0]?.antecedent).toBe("context essay");
    // B's copy of "yes" is owned by A → no record; only its genuinely new turn.
    expect(bRecords.map((r) => r.human_text)).toEqual(["new short turn"]);
    expect(bRecords[0]?.index).toBe(0);
  });
});

// ---- v1 branching limitation -----------------------------------------------

describe("anaphora — v1 branching limitation (documented)", () => {
  // v1 uses a linear file-order scan for antecedent/decision selection, which can
  // pick the wrong branch on forked/regenerated conversations. parentUuid walking
  // is the planned v1.1 fix. Placeholder until then.
  it.todo(
    "v1.1: parentUuid-aware antecedent selection picks the correct branch on regenerated conversations",
  );
});
