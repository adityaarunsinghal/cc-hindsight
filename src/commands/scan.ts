import { defineCommand } from "citty";
import { discoverProjects } from "../core/discover.js";
import { dim, hint, table } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** Format a Date as a human, sortable day stamp: `2026-07-13`. */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Scan behavior, shared with the root command (running with no args = scan). */
export function runScan(args: { home?: string; "claude-dir"?: string }): void {
  const { claudeDir } = resolvePaths(args);
  const projects = discoverProjects(claudeDir);

  if (projects.length === 0) {
    console.log(`No Claude Code projects found under ${claudeDir}/projects`);
    console.log(
      dim("Point at a different location with --claude-dir <path> (or set CLAUDE_CONFIG_DIR)."),
    );
    return;
  }

  // Sort by latest activity, most recent first. Empty projects (no mtime) sink.
  const sorted = [...projects].sort(
    (a, b) => (b.latestMtime?.getTime() ?? 0) - (a.latestMtime?.getTime() ?? 0),
  );

  const rows = sorted.map((p) => [
    p.shortName,
    String(p.sessions.length),
    String(p.entryTotal),
    p.latestMtime ? formatDate(p.latestMtime) : "-",
  ]);

  console.log(table(rows, { header: ["Project", "Sessions", "Entries", "Latest"] }));

  const sessionTotal = projects.reduce((sum, p) => sum + p.sessions.length, 0);
  console.log("");
  console.log(`${projects.length} projects, ${sessionTotal} sessions`);
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
