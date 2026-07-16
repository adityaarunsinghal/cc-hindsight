import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runScan } from "../src/commands/scan.js";

// Always drive scan with the synthetic fixture claude dir, never real ~/.claude.
const CLAUDE_HOME = path.join(import.meta.dirname, "fixtures", "claude-home");
const NO_PROJECTS_HOME = path.join(import.meta.dirname, "fixtures", "claude-home-noprojects");
const PROJECTS = path.join(CLAUDE_HOME, "projects");

const MTIMES: Record<string, string> = {
  "-Users-alice-projects-webapp/s1.jsonl": "2026-07-10T10:00:00Z",
  "-Users-alice-projects-webapp/s2.jsonl": "2026-07-11T09:30:00Z",
  "-Users-alice-projects-api/main.jsonl": "2026-07-12T14:00:00Z",
  "-Users-alice-my-cool-app/session.jsonl": "2026-07-09T08:00:00Z",
  "-Users-bob-webapp/session.jsonl": "2026-07-08T12:00:00Z",
};

beforeAll(() => {
  for (const [rel, iso] of Object.entries(MTIMES)) {
    const when = new Date(iso);
    fs.utimesSync(path.join(PROJECTS, rel), when, when);
  }
});

/**
 * Run `scan` and capture its (VT-stripped) stdout. Pins `source: "claude"` so a
 * test machine's real ~/.kiro store can never leak into these fixture-scoped
 * assertions (the "tests never read the real store" rule extends to kiro).
 */
function captureScan(args: { "claude-dir"?: string; source?: string }): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  try {
    runScan({ source: "claude", ...args });
  } finally {
    spy.mockRestore();
  }
  return stripVTControlCharacters(logs.join("\n"));
}

describe("scan command", () => {
  it("renders the inventory table with the documented columns", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    expect(out).toContain("Project");
    expect(out).toContain("Sessions");
    expect(out).toContain("Entries");
    expect(out).toContain("Latest");
    // Human date format.
    expect(out).toContain("2026-07-12");
  });

  it("lists every project including disambiguated short names", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    for (const name of ["webapp", "api", "app", "webapp-2", "empty"]) {
      expect(out).toContain(name);
    }
  });

  it("sorts projects by latest activity, most recent first", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    const names = ["api", "webapp", "app", "webapp-2", "empty"];
    // First table column holds the project short name; read them in row order.
    const order = out
      .split("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI styling
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))
      .map((line) => line.split("  ")[0]?.trim() ?? "")
      .filter((name) => names.includes(name));
    expect(order).toEqual(["api", "webapp", "app", "webapp-2", "empty"]);
  });

  it("prints a totals line and the export funnel hint", () => {
    const out = captureScan({ "claude-dir": CLAUDE_HOME });
    expect(out).toContain("5 projects, 5 sessions");
    expect(out).toContain("→ next: cc-hindsight export");
  });

  it("shows a friendly message pointing at --claude-dir when nothing is found", () => {
    const out = captureScan({ "claude-dir": NO_PROJECTS_HOME });
    expect(out).toContain("No Claude Code projects found");
    expect(out).toContain("--claude-dir");
  });

  it("inventories kiro sessions grouped by cwd under --source kiro", () => {
    const KIRO_HOME = path.join(import.meta.dirname, "fixtures", "kiro-home");
    const out = captureScanKiro({ "kiro-dir": KIRO_HOME });
    expect(out).toContain("webapp");
    expect(out).toContain("api");
    expect(out).toContain("→ next: cc-hindsight export");
  });

  it("shows a kiro-specific message pointing at --kiro-dir when nothing is found", () => {
    const out = captureScanKiro({ "kiro-dir": NO_PROJECTS_HOME });
    expect(out).toContain("No kiro-cli sessions found");
    expect(out).toContain("--kiro-dir");
  });
});

/** Run `scan --source kiro` and capture its (VT-stripped) stdout. */
function captureScanKiro(args: { "kiro-dir"?: string }): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  try {
    runScan({ source: "kiro", ...args });
  } finally {
    spy.mockRestore();
  }
  return stripVTControlCharacters(logs.join("\n"));
}
