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

/**
 * Publish root-level path flags so the dispatched subcommand honors them.
 *
 * `--help` presents `--home`, `--claude-dir` and `--kiro-dir` as ROOT options,
 * but citty does not thread a parent's parsed args into a subcommand: each one
 * re-declares the same names and reads only its own. So `cc-hindsight --home X
 * export` parsed `--home`, dropped it, and wrote to the DEFAULT store. The
 * failure was silent and it targeted exactly the flags that decide where data
 * is read from and written to (observed for real: an `export` intended for a
 * scratch dir ran against the live store and pruned it).
 *
 * The fix rides the precedence `resolvePaths` already implements
 * (flag > env > default): write the root flag into the environment, so it beats
 * the default while a subcommand-level flag still beats it. Only ever fills a
 * variable the user did not set, so `CC_HINDSIGHT_HOME=… cc-hindsight …` is
 * untouched. Runs in `setup`, which citty calls BEFORE the subcommand; the root
 * `run` fires after it and would be too late.
 *
 * When both placements are given, citty parses them into one flat namespace and
 * the later (subcommand-level) value wins, which is the specific-beats-general
 * behavior a reader expects.
 */
function publishRootPaths(args: Record<string, unknown>): void {
  const envForFlag = {
    home: "CC_HINDSIGHT_HOME",
    "claude-dir": "CLAUDE_CONFIG_DIR",
    "kiro-dir": "KIRO_CONFIG_DIR",
  } as const;
  for (const [flag, envVar] of Object.entries(envForFlag)) {
    const value = args[flag];
    if (typeof value === "string" && value !== "") process.env[envVar] = value;
  }
}

/** Root command. Running with no subcommand performs the safe default: scan. */
export const main = defineCommand({
  meta: {
    name: "cc-hindsight",
    version: pkg.version,
    description: pkg.description,
  },
  args: { ...sharedArgs },
  setup({ args }) {
    publishRootPaths(args as unknown as Record<string, unknown>);
  },
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
