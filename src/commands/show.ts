import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
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
      required: false,
    },
  },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`show: not implemented yet (would read ${home}/library)`);
    console.log(hint("cc-hindsight copy <slug>"));
  },
});
