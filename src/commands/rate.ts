import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { writeFilePrivate } from "../core/fsutil.js";
import { findEntry } from "../core/library.js";
import { green, hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/**
 * commands/rate.ts — record a verdict on a oneshot.
 *
 * `rating: up|down` + `rated_at` land in `sources.json` (declared optional in
 * its schema). `list` shows the badge; a rating is feedback for the user's
 * own curation — it never changes pipeline behavior.
 */

export interface RateArgs {
  home?: string;
  "claude-dir"?: string;
  slug?: string;
  rating?: string;
}

export interface RateDeps {
  output?: Writable;
}

/** Testable core of `rate`. Returns the process exit code. */
export function runRate(args: RateArgs, deps: RateDeps = {}): number {
  const { home } = resolvePaths(args);
  const out = deps.output ?? process.stdout;
  const write = (s: string) => out.write(`${s}\n`);

  const slug = String(args.slug ?? "");
  const rating = String(args.rating ?? "");
  if (rating !== "up" && rating !== "down") {
    write(`rating must be "up" or "down" (got "${rating}").`);
    return 1;
  }

  const entry = findEntry(home, slug);
  if (!entry) {
    write(`no library entry "${slug}" — try \`cc-hindsight list\`.`);
    return 1;
  }

  const sources = {
    ...entry.sources,
    rating: rating as "up" | "down",
    rated_at: new Date().toISOString(),
  };
  writeFilePrivate(path.join(entry.dir, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);

  write(green(`${rating === "up" ? "▲" : "▼"} ${slug} rated ${rating}.`));
  write(hint("cc-hindsight list"));
  return 0;
}

export default defineCommand({
  meta: {
    name: "rate",
    description: "Rate a oneshot up or down (recorded in its provenance)",
  },
  args: {
    ...sharedArgs,
    slug: {
      type: "positional",
      description: "Library entry slug",
      required: true,
    },
    rating: {
      type: "positional",
      description: "up or down",
      required: true,
    },
  },
  run({ args }) {
    const code = runRate(args as unknown as RateArgs);
    if (code !== 0) process.exitCode = code;
  },
});
