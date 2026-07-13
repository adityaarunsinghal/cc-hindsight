import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMessages } from "../src/core/extract.js";

/** Load a synthetic fixture as raw JSONL lines (never the real ~/.claude). */
function load(name: string): string[] {
  const url = new URL(`./fixtures/extract/${name}`, import.meta.url);
  return readFileSync(url, "utf8").split(/\r?\n/);
}

const texts = (name: string): string[] => extractMessages(load(name)).messages.map((m) => m.text);
const reasons = (name: string): string[] => extractMessages(load(name)).drops.map((d) => d.reason);

describe("R1 — admission (user + attachment are candidates; others ignored)", () => {
  it("admits user and attachment entries, silently ignores assistant", () => {
    const res = extractMessages(load("r1-admission.jsonl"));
    expect(res.messages.map((m) => m.text)).toEqual([
      "Please add a health check endpoint.",
      "Also add structured logging.",
    ]);
    expect(res.drops).toEqual([]); // the assistant turn is not a candidate, not a Drop
    expect(res.badLines).toBe(0);
  });
});

describe("R2 — rejection before reading content", () => {
  it("drops isMeta entries, keeps genuine ones", () => {
    expect(texts("r2-meta.jsonl")).toEqual(["Real human message."]);
    expect(reasons("r2-meta.jsonl")).toEqual(["R2: isMeta"]);
  });

  it("drops isSidechain (subagent) entries", () => {
    expect(texts("r2-sidechain.jsonl")).toEqual([]);
    expect(reasons("r2-sidechain.jsonl")).toEqual(["R2: isSidechain"]);
  });

  it("drops isCompactSummary and isVisibleInTranscriptOnly entries", () => {
    expect(texts("r2-compact-summary.jsonl")).toEqual([]);
    expect(reasons("r2-compact-summary.jsonl")).toEqual([
      "R2: isCompactSummary",
      "R2: isVisibleInTranscriptOnly",
    ]);
  });

  it("drops sdk entrypoint automation", () => {
    expect(texts("r2-sdk-entrypoint.jsonl")).toEqual([]);
    expect(reasons("r2-sdk-entrypoint.jsonl")).toEqual(["R2: sdk entrypoint"]);
  });

  it("GUARD: keeps promptSource==='sdk' when entrypoint is not sdk (VS Code typing)", () => {
    expect(texts("r2-promptsource-guard.jsonl")).toEqual([
      "Typed by a human in VS Code — keep me.",
    ]);
    expect(reasons("r2-promptsource-guard.jsonl")).toEqual([]);
  });
});

describe("R3 — attachment admission (human queued_command prompts only)", () => {
  it("admits the human prompt, drops assistant-origin and non-prompt attachments", () => {
    expect(texts("r3-queued-command.jsonl")).toEqual(["Run the tests again."]);
    expect(reasons("r3-queued-command.jsonl")).toEqual([
      "R3: non-human or non-prompt attachment",
      "R3: non-human or non-prompt attachment",
    ]);
  });
});

describe("R4 — string content cleaned per R6", () => {
  it("trims kept text and drops a whitespace-only piece", () => {
    expect(texts("r4-string-content.jsonl")).toEqual(["Fix the flaky test in auth.spec.ts"]);
    expect(reasons("r4-string-content.jsonl")).toEqual(["R6: empty piece"]);
  });
});

describe("R5 — tool-rejection recovery ('the user said:')", () => {
  it("recovers only the human follow-up after the marker; ignores plain tool output", () => {
    expect(texts("r5-tool-rejection.jsonl")).toEqual([
      "Use a migration instead of editing the schema directly.",
    ]);
    // Plain tool_result is machine output — ignored, not dropped.
    expect(reasons("r5-tool-rejection.jsonl")).toEqual([]);
  });
});

describe("R6 — per-piece cleaning", () => {
  it("keeps human prose beside a dropped <ide_opened_file> block; empty entries emit nothing", () => {
    const res = extractMessages(load("r6-ide-block-survival.jsonl"));
    expect(res.messages.map((m) => m.text)).toEqual(["Refactor this file to use async/await."]);
    expect(res.drops.map((d) => d.reason)).toEqual([
      "R6: machine block (leading <)",
      "R6: machine block (leading <)",
    ]);
  });

  it("drops interruption markers per-piece while human prose survives", () => {
    expect(texts("r6-interruption.jsonl")).toEqual(["Stop and just show me the diff."]);
    expect(reasons("r6-interruption.jsonl")).toEqual([
      "R6: interruption marker",
      "R6: interruption marker",
    ]);
  });
});

describe("R7 — AskUserQuestion decision recovery", () => {
  it('renders [decision] "Q" → A lines, joining multi-select answers', () => {
    expect(texts("r7-decision.jsonl")).toEqual([
      '[decision] "Which database should we use?" → PostgreSQL',
      '[decision] "Which features to include?" → Auth, Billing',
    ]);
    expect(reasons("r7-decision.jsonl")).toEqual([]);
  });
});

describe("R10 — command recovery (before the R6 '<' drop)", () => {
  it("recovers slash-commands with/without args; <local-command-stdout> still drops", () => {
    expect(texts("r10-command.jsonl")).toEqual(["[command] /review src/", "[command] /deploy"]);
    expect(reasons("r10-command.jsonl")).toEqual(["R6: machine block (leading <)"]);
  });
});

describe("R11 — non-text input markers", () => {
  it("emits [image pasted] in position beside text, and standalone", () => {
    expect(texts("r11-image.jsonl")).toEqual([
      "Here's the screenshot of the error:\n\n[image pasted]",
      "[image pasted]",
    ]);
    expect(reasons("r11-image.jsonl")).toEqual([]);
  });
});

describe("tolerant parsing", () => {
  it("skips and counts corrupt / non-object lines, never aborting", () => {
    const res = extractMessages(load("corrupt-lines.jsonl"));
    expect(res.messages.map((m) => m.text)).toEqual([
      "First valid message.",
      "Second valid message.",
    ]);
    expect(res.badLines).toBe(3); // broken JSON, bare `42`, and truncated object
  });

  it("tolerates entries missing a timestamp, preserving order with ts=''", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "No timestamp here." } }),
    ];
    expect(extractMessages(lines).messages).toEqual([
      { timestamp: "", text: "No timestamp here." },
    ]);
  });

  it("emits no message when an entry has zero surviving pieces", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "t",
        message: { role: "user", content: "<system-reminder>noise</system-reminder>" },
      }),
    ];
    const res = extractMessages(lines);
    expect(res.messages).toEqual([]);
    expect(res.drops).toHaveLength(1);
  });

  it("ignores blank lines without counting them as corrupt", () => {
    const res = extractMessages(["", "   ", ""]);
    expect(res.messages).toEqual([]);
    expect(res.badLines).toBe(0);
  });
});

describe("mixed-session — the regression wall (exact output, in order)", () => {
  it("yields exactly the human messages, nothing else, with drops recorded", () => {
    const res = extractMessages(load("mixed-session.jsonl"));
    expect(res.messages.map((m) => m.text)).toEqual([
      "Set up a CI pipeline for this repo.",
      "Also run it on macOS.",
      "Use GitHub Actions, Node 22.",
      '[decision] "Which test runner?" → vitest',
      "[command] /review ci.yml",
      "See the failing run:\n\n[image pasted]",
      "Pin the action versions.",
    ]);
    expect(res.drops.map((d) => d.reason)).toEqual([
      "R2: isMeta",
      "R6: machine block (leading <)",
      "R6: interruption marker",
      "R6: empty piece",
    ]);
    expect(res.badLines).toBe(0);
    // Snippets are bounded for --verbose reporting.
    for (const drop of res.drops) expect(drop.snippet.length).toBeLessThanOrEqual(120);
  });

  it("preserves timestamps on emitted messages", () => {
    const res = extractMessages(load("mixed-session.jsonl"));
    expect(res.messages[0]?.timestamp).toBe("2026-02-01T00:00:00.000Z");
    expect(res.messages.at(-1)?.timestamp).toBe("2026-02-01T00:00:08.000Z");
  });
});
