import { describe, expect, it } from "vitest";
import { parseRunnerMode, resolveRunner } from "../src/runners/registry.js";
import type { RunnerIo } from "../src/runners/shared.js";

/** An IO whose PATH contains exactly the given binaries; spawn is never used. */
function ioWith(...bins: string[]): RunnerIo {
  return {
    which: (bin) => (bins.includes(bin) ? `/usr/bin/${bin}` : null),
    spawn: async () => {
      throw new Error("registry tests never spawn");
    },
  };
}

describe("parseRunnerMode", () => {
  it("defaults to auto and accepts the three modes", () => {
    expect(parseRunnerMode(undefined)).toBe("auto");
    expect(parseRunnerMode("KIRO")).toBe("kiro");
  });
  it("rejects unknown values", () => {
    expect(() => parseRunnerMode("gpt")).toThrow(/unknown --runner/);
  });
});

describe("resolveRunner — explicit modes fail fast on a missing binary", () => {
  it("explicit kiro with no kiro-cli throws missing-binary with the kiro hint at RESOLVE time", async () => {
    await expect(resolveRunner("kiro", { io: ioWith("claude") })).rejects.toMatchObject({
      kind: "missing-binary",
      message: expect.stringContaining("kiro-cli"),
    });
  });

  it("explicit claude with no claude throws missing-binary at RESOLVE time", async () => {
    await expect(resolveRunner("claude", { io: ioWith("kiro-cli") })).rejects.toMatchObject({
      kind: "missing-binary",
    });
  });

  it("explicit modes resolve when the binary exists", async () => {
    expect((await resolveRunner("kiro", { io: ioWith("kiro-cli") })).name).toBe("kiro");
    expect((await resolveRunner("claude", { io: ioWith("claude") })).name).toBe("claude");
  });
});

describe("resolveRunner — auto", () => {
  it("prefers the runner matching the active source when installed", async () => {
    const r = await resolveRunner("auto", {
      io: ioWith("claude", "kiro-cli"),
      preferSource: "kiro",
    });
    expect(r.name).toBe("kiro");
  });

  it("falls back to whichever binary exists (kiro-only machine works)", async () => {
    const r = await resolveRunner("auto", { io: ioWith("kiro-cli") });
    expect(r.name).toBe("kiro");
  });

  it("prefers claude when both exist and no source preference is given", async () => {
    const r = await resolveRunner("auto", { io: ioWith("claude", "kiro-cli") });
    expect(r.name).toBe("claude");
  });

  it("returns the claude runner when neither binary exists (its hint surfaces on use)", async () => {
    const r = await resolveRunner("auto", { io: ioWith() });
    expect(r.name).toBe("claude");
  });
});
