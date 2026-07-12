import { defineCommand } from "citty";
import { hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** Scan behavior, shared with the root command (running with no args = scan). */
export function runScan(args: { home?: string; "claude-dir"?: string }): void {
  const { claudeDir } = resolvePaths(args);
  console.log(`scan: not implemented yet (would read ${claudeDir})`);
  console.log(hint("cc-hindsight export"));
}

export default defineCommand({
  meta: {
    name: "scan",
    description: "Inventory Claude Code projects and sessions",
  },
  args: { ...sharedArgs },
  run({ args }) {
    runScan(args);
  },
});
