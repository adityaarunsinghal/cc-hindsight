import { describe, expect, it } from "vitest";
import { AuthorSchema, ClusterSchema, DigestSchema, toJsonSchema } from "../src/claude/schemas.js";

describe("DigestSchema", () => {
  it("accepts a valid digest", () => {
    const d = {
      goal: "g",
      deliverable: "d",
      domain: "dom",
      keywords: ["a", "b"],
      outcome: "completed" as const,
    };
    expect(DigestSchema.parse(d)).toEqual(d);
  });

  it("rejects an unknown outcome value", () => {
    expect(() =>
      DigestSchema.parse({
        goal: "g",
        deliverable: "d",
        domain: "dom",
        keywords: [],
        outcome: "nope",
      }),
    ).toThrow();
  });
});

describe("ClusterSchema", () => {
  it("accepts tasks + misc", () => {
    const c = {
      tasks: [{ slug: "s", title: "t", rationale: "r", members: ["m1"] }],
      misc: ["m2"],
    };
    expect(ClusterSchema.parse(c)).toEqual(c);
  });
});

describe("AuthorSchema", () => {
  it("accepts a oneshot with preferences", () => {
    const a = {
      slug: "s",
      title: "t",
      oneshot_markdown: "# do the thing",
      confidence: "high" as const,
      preferences: [{ text: "be terse", evidence: "session 3" }],
    };
    expect(AuthorSchema.parse(a)).toEqual(a);
  });
});

describe("toJsonSchema", () => {
  it("derives an object JSON Schema with required fields and an enum", () => {
    const js = toJsonSchema(DigestSchema);
    expect(js.type).toBe("object");
    const props = js.properties as Record<string, { enum?: string[] }>;
    expect(props.outcome?.enum).toEqual(["completed", "partial", "abandoned", "unclear"]);
    expect(js.required).toEqual(
      expect.arrayContaining(["goal", "deliverable", "domain", "keywords", "outcome"]),
    );
  });

  it("derives object schemas for cluster and author too", () => {
    expect(toJsonSchema(ClusterSchema).type).toBe("object");
    expect(toJsonSchema(AuthorSchema).type).toBe("object");
  });

  it("emits draft-7-compatible schemas with no $schema key (real claude CLI compat)", () => {
    // claude v2.1.207's ajv only ships the draft-07 meta-schema; zod's default
    // draft-2020-12 dialect is rejected at the flag level before any API call.
    for (const schema of [DigestSchema, ClusterSchema, AuthorSchema]) {
      const js = toJsonSchema(schema);
      expect(js.$schema).toBeUndefined();
      expect(JSON.stringify(js)).not.toContain("2020-12");
    }
  });
});
