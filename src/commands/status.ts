import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "status",
    description: "Pipeline funnel: discovered → exported → digested → clustered → authored",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`status: not implemented yet (would read ${home})`);
    console.log(hint("cc-hindsight scan"));
  },
});
