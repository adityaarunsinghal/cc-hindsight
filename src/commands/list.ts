import { defineCommand } from "citty";
import { readLibrary } from "../core/library.js";
import { renderLibraryTable } from "../ui/library-table.js";
import { green, hint } from "../ui/style.js";
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

    console.log(renderLibraryTable(entries));
    console.log();
    console.log(green(`${entries.length} librar${entries.length === 1 ? "y entry" : "y entries"}`));
    console.log(hint("cc-hindsight show <slug>"));
  },
});
