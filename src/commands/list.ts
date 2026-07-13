import { defineCommand } from "citty";
import { readLibrary } from "../core/library.js";
import { bold, dim, green, hint, magenta, red, table, yellow } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

const CONFIDENCE_COLOR = { high: green, medium: yellow, low: red } as const;

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
          CONFIDENCE_COLOR[e.sources.confidence](e.sources.confidence),
          dim(e.sources.authored_at.slice(0, 10)),
        ]),
        { header: ["Slug", "Title", "Domain", "Sessions", "Confidence", "Authored"] },
      ),
    );
    console.log();
    console.log(green(`${entries.length} librar${entries.length === 1 ? "y entry" : "y entries"}`));
    console.log(hint("cc-hindsight show <slug>"));
  },
});
