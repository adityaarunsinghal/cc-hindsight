import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "copy",
    description: "Copy a oneshot prompt to the clipboard",
  },
  args: {
    ...sharedArgs,
    slug: {
      type: "positional",
      description: "Library entry slug",
      required: false,
    },
  },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`copy: not implemented yet (would read ${home}/library)`);
    console.log(hint("paste it into a fresh Claude Code session"));
  },
});
