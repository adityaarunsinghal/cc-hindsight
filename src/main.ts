import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { sharedArgs } from "./commands/_shared.js";
import copy from "./commands/copy.js";
import distill from "./commands/distill.js";
import edit from "./commands/edit.js";
import exportCmd from "./commands/export.js";
import list from "./commands/list.js";
import preferences from "./commands/preferences.js";
import prune from "./commands/prune.js";
import rate from "./commands/rate.js";
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
    edit,
    rate,
    prune,
    status,
    preferences,
  },
  run({ args }) {
    // citty invokes the root run() even after dispatching a subcommand, so we
    // must decide whether this invocation was bare. Use the PARSED positionals
    // (args._): a raw-args scan can't tell a subcommand token from an option
    // VALUE (`--claude-dir /path` — the value doesn't start with "-"), but the
    // parser is schema-aware and has already consumed string-flag values, so a
    // non-empty args._ means a real positional/subcommand was given.
    if (Array.isArray(args._) && args._.length > 0) return;
    runScan(args);
  },
});
