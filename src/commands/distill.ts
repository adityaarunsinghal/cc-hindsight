import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

export default defineCommand({
  meta: {
    name: "distill",
    description: "Digest, cluster, and author oneshot prompts (consent-gated)",
  },
  args: { ...sharedArgs },
  run({ args }) {
    const { home } = resolvePaths(args);
    console.log(`distill: not implemented yet (would write ${home}/library)`);
    console.log(hint("cc-hindsight list"));
  },
});
