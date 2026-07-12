import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { sharedArgs } from "./commands/_shared.js";
import copy from "./commands/copy.js";
import distill from "./commands/distill.js";
import exportCmd from "./commands/export.js";
import list from "./commands/list.js";
import preferences from "./commands/preferences.js";
import scan, { runScan } from "./commands/scan.js";
import show from "./commands/show.js";
import status from "./commands/status.js";

/** Root command. Running with no subcommand performs the safe default: scan. */
export const main = defineCommand({
  meta: {
    name: "cc-hindsight",
    version: pkg.version,
    description: pkg.description,
  },
  args: { ...sharedArgs },
  subCommands: {
    scan,
    export: exportCmd,
    distill,
    list,
    show,
    copy,
    status,
    preferences,
  },
  run({ args, rawArgs }) {
    // citty invokes the root run() even after dispatching a subcommand; only
    // perform the default action (scan) when no subcommand token was present.
    // This mirrors citty's own detection: first non-dash token = subcommand.
    if (rawArgs.some((a) => !a.startsWith("-"))) return;
    runScan(args);
  },
});
