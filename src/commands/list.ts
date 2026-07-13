import { defineCommand } from "citty";
import { isEdited, readLibrary } from "../core/library.js";
import { bold, dim, green, hint, magenta, red, table, yellow } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

const CONFIDENCE_COLOR = { high: green, medium: yellow, low: red } as const;

/** Badge column: hand-edited marker + rating verdict. */
function badges(edited: boolean, rating: "up" | "down" | null | undefined): string {
  const parts: string[] = [];
  if (edited) parts.push(yellow("✎ edited"));
  if (rating === "up") parts.push(green("▲"));
  if (rating === "down") parts.push(red("▼"));
  return parts.join(" ");
}

export default defineCommand({
  meta: {
    name: "list",
    description: "List the oneshot prompt library",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    const entries = readLibrary(home);

    if (entries.length === 0) {
      console.log("library is empty — nothing distilled yet.");
      console.log(hint("cc-hindsight distill"));
      return;
    }

    console.log(
      table(
        entries.map((e) => [
          bold(e.slug),
          e.sources.title,
          magenta(e.sources.domains.join(", ")),
          String(e.sources.members.length),
          (CONFIDENCE_COLOR[e.sources.confidence] ?? dim)(e.sources.confidence),
          dim(e.sources.authored_at.slice(0, 10)),
          badges(isEdited(e), e.sources.rating),
        ]),
        { header: ["Slug", "Title", "Domain", "Sessions", "Confidence", "Authored", ""] },
      ),
    );
    console.log();
    console.log(green(`${entries.length} librar${entries.length === 1 ? "y entry" : "y entries"}`));
    console.log(hint("cc-hindsight show <slug>"));
  },
});
