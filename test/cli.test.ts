import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMain } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { main } from "../src/main.js";
import { epipeHandler } from "../src/ui/epipe.js";

const EXPECTED = [
  "scan",
  "export",
  "distill",
  "list",
  "show",
  "copy",
  "edit",
  "rate",
  "prune",
  "status",
  "preferences",
];

describe("cc-hindsight root command", () => {
  it("has the right name and reports the package version", () => {
    const meta = main.meta as { name: string; version: string };
    expect(meta.name).toBe("cc-hindsight");
    // Read from package.json so a version bump can never silently drift this
    // assertion (the CLI's contract is "report the package version", not a
    // hardcoded literal).
    expect(meta.version).toBe(pkg.version);
  });

  it("registers all 8 subcommands", () => {
    const subCommands = main.subCommands as Record<string, unknown>;
    expect(Object.keys(subCommands).sort()).toEqual([...EXPECTED].sort());
  });

  it("each subcommand is a citty command with matching meta.name", async () => {
    const subCommands = main.subCommands as Record<string, unknown>;
    for (const name of EXPECTED) {
      const cmd = subCommands[name] as { meta?: { name?: string }; run?: unknown };
      expect(cmd, `subcommand ${name}`).toBeDefined();
      expect(cmd.meta?.name).toBe(name);
      expect(typeof cmd.run).toBe("function");
    }
  });
});

// --- dispatch through citty: the heuristic that decides default-scan vs.
// subcommand must survive flag VALUES that look like tokens. ------------

describe("root dispatch", () => {
  // A fixture claude dir with no `projects` → runScan prints the friendly
  // "No Claude Code projects found" line. We assert scan ran (or didn't) by
  // watching console.log, without touching the real ~/.claude.
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let emptyClaudeDir: string;
  const tmp: string[] = [];

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      logs.push(p.map(String).join(" "));
    });
    emptyClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-dispatch-"));
    tmp.push(emptyClaudeDir);
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const ranScan = () => logs.join("\n").includes("No Claude Code projects found");

  // `--source claude` keeps these dispatch tests hermetic: without it, `auto`
  // would also read the machine's real ~/.kiro store (the "never read the real
  // store" rule extends to kiro), and scan would find sessions there.
  it("runs the default scan on a bare invocation", async () => {
    await runMain(main, { rawArgs: ["--claude-dir", emptyClaudeDir, "--source", "claude"] });
    expect(ranScan()).toBe(true);
  });

  it("runs the default scan when the only args are flags WITH values", async () => {
    // A naive raw-args heuristic ("first non-dash token = subcommand") would
    // mistake the VALUE `emptyClaudeDir` for a subcommand and skip the scan —
    // dispatch must rely on parsed positionals instead.
    await runMain(main, {
      rawArgs: ["--home", emptyClaudeDir, "--claude-dir", emptyClaudeDir, "--source", "claude"],
    });
    expect(ranScan()).toBe(true);
  });

  it("does NOT run the default scan when an explicit subcommand is given", async () => {
    // `status` against a home with nothing → prints funnel, never the scan line.
    await runMain(main, {
      rawArgs: [
        "status",
        "--home",
        emptyClaudeDir,
        "--claude-dir",
        emptyClaudeDir,
        "--source",
        "claude",
      ],
    });
    expect(ranScan()).toBe(false);
    expect(logs.join("\n")).toContain("discovered");
  });
});

// --- root-level path flags must reach the subcommand ----------------------
//
// `--help` documents --home/--claude-dir/--kiro-dir as ROOT options, but citty
// does not thread a parent's parsed args into a subcommand: the subcommand
// re-declares the same names and sees only its own. So `cc-hindsight --home X
// export` parsed --home, discarded it, and wrote to the DEFAULT store instead.
// Silent, and aimed squarely at the flags that redirect where data is read and
// written. Observed for real: an `export` meant for a scratch dir ran against
// the live store.

describe("root-level path flags reach the subcommand", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const tmp: string[] = [];
  const savedEnv = { ...process.env };

  const mkdir = (tag: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `cch-rootflag-${tag}-`));
    tmp.push(d);
    return d;
  };

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      logs.push(p.map(String).join(" "));
    });
    for (const k of ["CC_HINDSIGHT_HOME", "CLAUDE_CONFIG_DIR", "KIRO_CONFIG_DIR"]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    for (const k of ["CC_HINDSIGHT_HOME", "CLAUDE_CONFIG_DIR", "KIRO_CONFIG_DIR"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("honors --home given BEFORE the subcommand", async () => {
    const home = mkdir("home");
    const claudeDir = mkdir("claude");
    // `status` reads the home's library/exports; a fresh dir reports a zeroed
    // funnel. If the root --home were dropped we would read the real store.
    await runMain(main, {
      rawArgs: ["--home", home, "--claude-dir", claudeDir, "--source", "claude", "status"],
    });
    expect(process.env.CC_HINDSIGHT_HOME).toBe(home);
    expect(logs.join("\n")).toContain("exported    0 session(s)");
  });

  it("honors --claude-dir and --kiro-dir given BEFORE the subcommand", async () => {
    const home = mkdir("home2");
    const claudeDir = mkdir("claude2");
    const kiroDir = mkdir("kiro2");
    await runMain(main, {
      rawArgs: [
        "--home",
        home,
        "--claude-dir",
        claudeDir,
        "--kiro-dir",
        kiroDir,
        "--source",
        "claude",
        "status",
      ],
    });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
    expect(process.env.KIRO_CONFIG_DIR).toBe(kiroDir);
    // An empty claude dir has no sessions to discover.
    expect(logs.join("\n")).toContain("discovered  0 session(s)");
  });

  it("lets a subcommand-level flag win over the root-level one", async () => {
    const rootHome = mkdir("root");
    const subHome = mkdir("sub");
    const claudeDir = mkdir("claude3");
    // The more specific flag is the one the user typed closest to the command.
    await runMain(main, {
      rawArgs: [
        "--home",
        rootHome,
        "--claude-dir",
        claudeDir,
        "--source",
        "claude",
        "status",
        "--home",
        subHome,
      ],
    });
    expect(process.env.CC_HINDSIGHT_HOME).toBe(subHome);
  });

  it("leaves an existing env var alone when no root flag is given", async () => {
    const envHome = mkdir("env");
    const claudeDir = mkdir("claude4");
    process.env.CC_HINDSIGHT_HOME = envHome;
    await runMain(main, {
      rawArgs: ["--claude-dir", claudeDir, "--source", "claude", "status"],
    });
    expect(process.env.CC_HINDSIGHT_HOME).toBe(envHome);
  });
});

// --- EPIPE helper (extracted from cli.ts for testability) -------------------

describe("epipeHandler", () => {
  it("exits 0 on EPIPE", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    epipeHandler(exit)(err);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("re-throws any non-EPIPE error", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    expect(() => epipeHandler(exit)(err)).toThrow("disk full");
    expect(exit).not.toHaveBeenCalled();
  });
});
