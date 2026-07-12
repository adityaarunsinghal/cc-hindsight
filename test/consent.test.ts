import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConsentResult,
  confirm,
  type DistillPlan,
  renderPlan,
} from "../src/claude/consent.js";
import { computePlan, type ManifestEntry, runDistill } from "../src/commands/distill.js";

// --- helpers ---------------------------------------------------------------

function captureOutput(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { out, text: () => chunks.join("") };
}

function inputWith(line: string): Readable {
  const pt = new PassThrough();
  pt.end(line);
  return pt;
}

/** An input stream that throws if anything ever touches it. */
function forbiddenInput(): Readable {
  return new Proxy({} as Readable, {
    get() {
      throw new Error("stdin was accessed but must not be");
    },
  });
}

// --- renderPlan (exact §5.7 copy) ------------------------------------------

describe("renderPlan", () => {
  it("matches the exact §5.7 disclosure block (right-aligned counts)", () => {
    const expected = [
      "  distill will invoke your local `claude` CLI (your subscription/credits):",
      "    • 14 session digests",
      "    •  1 clustering call",
      "    • ~5 oneshot authoring calls (one per task; exact count known after clustering)",
      "  ≈ 20 invocations total. Nothing is sent anywhere except through your own claude CLI.",
    ].join("\n");
    expect(renderPlan({ digests: 14, cluster: 1, authorEstimate: 5 })).toBe(expected);
  });

  it("appends a resume note line when checkpoints exist", () => {
    const out = renderPlan({
      digests: 14,
      cluster: 1,
      authorEstimate: 5,
      resumeNote: "9 of 14 digests already done; will run 5 + 1 + ~5",
    });
    expect(out).toContain("  9 of 14 digests already done; will run 5 + 1 + ~5");
    // resume note is the last line
    expect(out.split("\n").at(-1)).toBe("  9 of 14 digests already done; will run 5 + 1 + ~5");
  });

  it("keeps single-digit counts aligned to the widest field", () => {
    const out = renderPlan({ digests: 5, cluster: 1, authorEstimate: 5 });
    const lines = out.split("\n");
    expect(lines[1]).toBe("    •  5 session digests");
    expect(lines[2]).toBe("    •  1 clustering call");
    expect(lines[3]).toContain("    • ~5 oneshot authoring calls");
  });
});

// --- confirm ---------------------------------------------------------------

const PLAN: DistillPlan = { digests: 14, cluster: 1, authorEstimate: 5 };

describe("confirm", () => {
  it("dry-run prints the plan and never touches stdin", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, {
      dryRun: true,
      input: forbiddenInput(),
      output: cap.out,
    });
    expect(result).toBe("dry-run");
    expect(cap.text()).toContain("≈ 20 invocations total");
  });

  it("--yes proceeds without touching stdin", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, {
      yes: true,
      input: forbiddenInput(),
      output: cap.out,
    });
    expect(result).toBe("proceed");
    expect(cap.text()).toContain("distill will invoke your local");
  });

  it("interactive 'y' proceeds", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("y\n"), output: cap.out });
    expect(result).toBe("proceed");
  });

  it("interactive 'yes' proceeds", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("yes\n"), output: cap.out });
    expect(result).toBe("proceed");
  });

  it("empty input declines (default No)", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("\n"), output: cap.out });
    expect(result).toBe("declined");
  });

  it("'n' declines", async () => {
    const cap = captureOutput();
    const result = await confirm(PLAN, { input: inputWith("n\n"), output: cap.out });
    expect(result).toBe("declined");
  });
});

// --- distill command wiring (consent + count math) -------------------------

function entry(name: string, project: string, messages: number): ManifestEntry {
  return {
    export: name,
    source: `/x/${name}.jsonl`,
    project,
    sessionId: name,
    messages,
    first_ts: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T01:00:00Z",
  };
}

const tmpDirs: string[] = [];
function tmpHome(entries: ManifestEntry[] | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-distill-"));
  tmpDirs.push(dir);
  if (entries) {
    fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "exports", "manifest.json"), JSON.stringify(entries));
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("computePlan (count math)", () => {
  it("filters by --min-substance and estimates authors at round(eligible/3)", () => {
    const entries = [
      entry("a", "alpha", 5),
      entry("b", "alpha", 3),
      entry("c", "alpha", 1), // excluded (< 2)
      entry("d", "beta", 4),
      entry("e", "beta", 2),
      entry("f", "beta", 10),
    ];
    const plan = computePlan(entries, { minSubstance: 2, noGroup: false });
    expect(plan.digests).toBe(5);
    expect(plan.cluster).toBe(1);
    expect(plan.authorEstimate).toBe(2); // max(1, round(5/3)) = 2
  });

  it("applies the --project filter (case-insensitive substring)", () => {
    const entries = [entry("a", "alpha", 5), entry("b", "beta", 4), entry("c", "beta", 2)];
    const plan = computePlan(entries, { project: "BET", minSubstance: 2, noGroup: false });
    expect(plan.digests).toBe(2);
    expect(plan.eligible.map((e) => e.export)).toEqual(["b", "c"]);
  });

  it("--no-group yields no cluster call and one author per session", () => {
    const entries = [entry("a", "x", 5), entry("b", "x", 3)];
    const plan = computePlan(entries, { minSubstance: 2, noGroup: true });
    expect(plan.cluster).toBe(0);
    expect(plan.authorEstimate).toBe(2);
  });

  it("zeroes everything when nothing is eligible", () => {
    const plan = computePlan([entry("a", "x", 1)], { minSubstance: 2, noGroup: false });
    expect(plan).toMatchObject({ digests: 0, cluster: 0, authorEstimate: 0 });
  });
});

describe("runDistill", () => {
  it("exits 1 with a hint when the manifest is missing", async () => {
    const cap = captureOutput();
    const code = await runDistill({ home: tmpHome(null) }, { output: cap.out });
    expect(code).toBe(1);
    expect(cap.text()).toContain("nothing exported yet");
    expect(cap.text()).toContain("cc-hindsight export");
  });

  it("exits 0 when nothing meets the substance threshold", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 1)]);
    const code = await runDistill({ home }, { output: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("nothing to distill");
  });

  it("passes the computed plan to the consent gate", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 3)]);
    let captured: DistillPlan | undefined;
    const confirmSpy = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    const code = await runDistill(
      { home, "min-substance": "2" },
      { confirm: confirmSpy, output: cap.out },
    );
    expect(code).toBe(0);
    expect(captured).toMatchObject({ digests: 2, cluster: 1, authorEstimate: 1 });
    expect(cap.text()).toContain("digest — 2 session(s):");
  });

  it("exits 2 when consent is declined", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5)]);
    const confirmSpy = async (): Promise<ConsentResult> => "declined";
    const code = await runDistill({ home }, { confirm: confirmSpy, output: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("declined");
  });

  it("exits 0 and reports the placeholder pipeline on proceed", async () => {
    const cap = captureOutput();
    const home = tmpHome([entry("a", "x", 5), entry("b", "x", 4)]);
    const confirmSpy = async (): Promise<ConsentResult> => "proceed";
    const code = await runDistill({ home }, { confirm: confirmSpy, output: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("pipeline not implemented yet");
  });

  it("surfaces a resume note when a digests checkpoint exists", async () => {
    const home = tmpHome([
      entry("a", "x", 5),
      entry("b", "x", 4),
      entry("c", "x", 3),
      entry("d", "x", 2),
    ]);
    fs.mkdirSync(path.join(home, "distill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "distill", "digests.json"),
      JSON.stringify({ generation: 1, digests: { a: {}, b: {} } }),
    );
    let captured: DistillPlan | undefined;
    const confirmSpy = async (plan: DistillPlan): Promise<ConsentResult> => {
      captured = plan;
      return "dry-run";
    };
    await runDistill({ home }, { confirm: confirmSpy, output: captureOutput().out });
    expect(captured?.resumeNote).toContain("2 of 4 digests already done");
  });
});
