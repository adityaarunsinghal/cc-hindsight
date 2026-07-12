import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "list",
    description: "List the oneshot prompt library",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`list: not implemented yet (would read ${home}/library)`);
    console.log(hint("cc-hindsight show <slug>"));
  },
});
