import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "export",
    description: "Export human-only session markdown + manifest",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`export: not implemented yet (would write ${home}/exports)`);
    console.log(hint("cc-hindsight distill"));
  },
});
