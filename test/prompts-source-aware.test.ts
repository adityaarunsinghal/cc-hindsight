import { describe, expect, it } from "vitest";
import {
  AUTHOR_PROMPT_VERSION,
  type AuthorMemberInput,
  buildAuthorPrompt,
} from "../src/claude/prompts/author.js";
import { buildClusterPrompt, CLUSTER_PROMPT_VERSION } from "../src/claude/prompts/cluster.js";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION } from "../src/claude/prompts/digest.js";
import type { ClusterTask, Digest } from "../src/claude/schemas.js";

/**
 * Source-aware prompt copy: the digest/cluster/author prompts name the
 * backend that produced each session and only explain the
 * [decision]/[command]/[image pasted] legend for sources that can produce
 * those lines (Claude Code). The claude-origin output stays byte-compatible
 * with the pre-multi-backend copy; the version constants were bumped with the
 * change (provenance freshness).
 */

const digest = (outcome: Digest["outcome"] = "completed"): Digest => ({
  goal: "g",
  deliverable: "d",
  domain: "x",
  keywords: ["k"],
  outcome,
});

describe("prompt versions were bumped with the source-aware copy change", () => {
  it("digest v2, cluster v3, author v3", () => {
    expect(DIGEST_PROMPT_VERSION).toBe(2);
    expect(CLUSTER_PROMPT_VERSION).toBe(3);
    expect(AUTHOR_PROMPT_VERSION).toBe(3);
  });
});

describe("digest prompt — source naming and legend", () => {
  const base = { exportName: "webapp-a1b2c3d4.md", content: "do the thing" };

  it("claude origin (and absent origin) keeps the original copy incl. the legend", () => {
    for (const origin of [undefined, "claude" as const]) {
      const prompt = buildDigestPrompt({ ...base, origin });
      expect(prompt).toContain("You are analyzing one Claude Code session");
      expect(prompt).toContain("[image pasted] marks visual context they supplied.");
      expect(prompt).toContain('Lines like [decision] "Q" → answer');
    }
  });

  it("kiro origin names Kiro CLI and omits the legend it cannot produce", () => {
    const prompt = buildDigestPrompt({ ...base, origin: "kiro" });
    expect(prompt).toContain("You are analyzing one Kiro CLI session");
    expect(prompt).toContain("(file: webapp-a1b2c3d4.md)");
    expect(prompt).not.toContain("[decision]");
    expect(prompt).not.toContain("[command]");
    expect(prompt).not.toContain("[image pasted] marks");
  });
});

describe("cluster prompt — corpus naming by origin set", () => {
  const digests = { "a.md": digest(), "b.md": digest() };

  it("all-claude (and absent origins) keeps the original naming", () => {
    expect(buildClusterPrompt(digests)).toContain("You are grouping Claude Code sessions");
    expect(buildClusterPrompt(digests, { "a.md": "claude", "b.md": "claude" })).toContain(
      "You are grouping Claude Code sessions",
    );
  });

  it("all-kiro names Kiro CLI", () => {
    expect(buildClusterPrompt(digests, { "a.md": "kiro", "b.md": "kiro" })).toContain(
      "You are grouping Kiro CLI sessions",
    );
  });

  it("a merged corpus goes neutral", () => {
    expect(buildClusterPrompt(digests, { "a.md": "claude", "b.md": "kiro" })).toContain(
      "You are grouping coding-agent sessions",
    );
  });
});

describe("author prompt — legend bullets follow the members' origins", () => {
  const task: ClusterTask = { slug: "the-task", title: "T", rationale: "r", members: ["a.md"] };
  const member = (origin?: AuthorMemberInput["origin"]): AuthorMemberInput => ({
    exportName: "a.md",
    content: "human words",
    digest: digest(),
    origin,
  });

  it("all-claude members (and absent origin) keep the [decision]/[command] bullets", () => {
    for (const m of [member(), member("claude")]) {
      const prompt = buildAuthorPrompt({ task, members: [m] });
      expect(prompt).toContain("[decision] lines are the human's verbatim choices");
      expect(prompt).toContain("[command] and [image pasted] lines");
    }
  });

  it("all-kiro members drop the legend bullets", () => {
    const prompt = buildAuthorPrompt({ task, members: [member("kiro")] });
    expect(prompt).not.toContain("[decision] lines are the human's verbatim choices");
    expect(prompt).not.toContain("[command] and [image pasted] lines");
    // The rest of the contract is untouched.
    expect(prompt).toContain('THE "KNOWABLE AT t=0" TEST');
  });

  it("a mixed-origin task keeps the bullets for its claude members", () => {
    const prompt = buildAuthorPrompt({
      task: { ...task, members: ["a.md", "b.md"] },
      members: [member("kiro"), { ...member("claude"), exportName: "b.md" }],
    });
    expect(prompt).toContain("[decision] lines are the human's verbatim choices");
  });
});
