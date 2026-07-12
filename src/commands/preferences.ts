import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "preferences",
    description: "Aggregate recurring preferences into a CLAUDE.md snippet",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`preferences: not implemented yet (would read ${home}/library)`);
    console.log(hint("paste the snippet into your CLAUDE.md"));
  },
});
