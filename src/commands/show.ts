import fs from "node:fs";
import { defineCommand } from "citty";
import { findEntry, parseOneshot } from "../core/library.js";
import { renderMarkdownAnsi } from "../ui/markdown.js";
import { bold, dim, hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "show",
    description: "Render a oneshot prompt to the terminal",
  },
  args: {
    ...sharedArgs,
    slug: {
      type: "positional",
      description: "Library entry slug",
      required: true,
    },
    raw: {
      type: "boolean",
      description: "Print the oneshot as raw markdown (no styling or wrapping)",
    },
  },
  run({ args }) {
    const { home } = resolvePaths(args);
    const slug = String(args.slug);
    const entry = findEntry(home, slug);
    if (!entry) {
      console.error(`no library entry "${slug}" — try \`cc-hindsight list\`.`);
      process.exitCode = 1;
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(entry.oneshotPath, "utf8");
    } catch {
      console.error(`entry "${slug}" has no oneshot file (${entry.oneshotPath}).`);
      process.exitCode = 1;
      return;
    }

    const { title, body } = parseOneshot(content);
    const s = entry.sources;
    const coverage =
      typeof s.input_coverage === "number" && s.input_coverage < 1
        ? ` · ${(s.input_coverage * 100).toFixed(1)}% of sources (truncated)`
        : "";
    console.log(bold(`# ${title ?? s.title ?? slug}`));
    console.log(
      dim(
        `${s.members?.length ?? 0} session(s) · ${s.outcome_summary ?? "?"} · ` +
          `confidence ${s.confidence ?? "?"} · authored ${(s.authored_at ?? "").slice(0, 10)}` +
          (s.domains?.length ? ` · domain: ${s.domains.join(", ")}` : "") +
          coverage,
      ),
    );
    console.log();
    if (args.raw || !process.stdout.isTTY) {
      // Raw markdown for piping (`show x | pbcopy`) and for --raw.
      console.log(body);
    } else {
      console.log(renderMarkdownAnsi(body));
    }
    console.log();
    console.log(hint(`cc-hindsight copy ${slug}`));
  },
});
