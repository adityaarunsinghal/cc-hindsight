import { defineCommand } from "citty";
import { readLibrary } from "../core/library.js";
import { hint, table } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

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
          e.slug,
          e.sources.title ?? "",
          String(e.sources.members?.length ?? 0),
          e.sources.confidence ?? "?",
          (e.sources.authored_at ?? "").slice(0, 10),
        ]),
        { header: ["Slug", "Title", "Sessions", "Confidence", "Authored"] },
      ),
    );
    console.log();
    console.log(`${entries.length} librar${entries.length === 1 ? "y entry" : "y entries"}`);
    console.log(hint("cc-hindsight show <slug>"));
  },
});
