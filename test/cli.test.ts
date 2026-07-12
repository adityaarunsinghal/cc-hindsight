import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

const EXPECTED = ["scan", "export", "distill", "list", "show", "copy", "status", "preferences"];

describe("cc-hindsight root command", () => {
  it("has the right name and version", () => {
    const meta = main.meta as { name: string; version: string };
    expect(meta.name).toBe("cc-hindsight");
    expect(meta.version).toBe("0.1.0");
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
