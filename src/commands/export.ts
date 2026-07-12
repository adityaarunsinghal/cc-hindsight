import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import { buildCorpus, type Corpus, type CorpusSession, type DedupeInput } from "../core/dedupe.js";
import { discoverProjects } from "../core/discover.js";
import { exportFileName, renderExport } from "../core/render.js";
import { dim, hint } from "../ui/style.js";
import { resolvePaths, sharedArgs } from "./_shared.js";

/** One entry of `exports/manifest.json` (§5.3). */
export interface ManifestEntry {
  export: string;
  source: string;
  project: string;
  sessionId: string;
  messages: number;
  first_ts: string;
  last_ts: string;
}

/** Normalized args the export core reads. */
export interface ExportArgs {
  home?: string;
  "claude-dir"?: string;
  /** Case-insensitive substring filter on project short name (R9). */
  project?: string;
  /** Minimum surviving human messages for a session to be exported (default 1). */
  "min-messages"?: string;
  verbose?: boolean;
  /** Injectable sink for testing; defaults to process.stdout. */
  output?: Writable;
}

/** What a run did — returned for tests and used to print the summary. */
export interface ExportStats {
  /** Sessions written to disk (messages ≥ min-messages). */
  exportedSessions: number;
  /** Total surviving messages across exported sessions. */
  totalMessages: number;
  /** Messages dropped as cross-file fork copies (R8). */
  duplicatesDropped: number;
  /** Sessions excluded by the `--project` filter. */
  skippedByFilter: number;
  /** Sessions with zero surviving human messages (skipped naturally, R9). */
  zeroMessageSessions: number;
  /** Sessions with some messages but fewer than `--min-messages`. */
  belowMinMessages: number;
  /** Session files that could not be read (skipped, tolerated). */
  readErrors: number;
  /** Corrupt JSONL lines skipped across all sessions. */
  badLines: number;
  /** Absolute path to the exports directory that was written. */
  exportsDir: string;
  /** Written markdown basenames, sorted (manifest.json excluded). */
  files: string[];
}

/** Parse `--min-messages`, defaulting to 1 and clamping sub-1 / invalid to 1. */
function parseMinMessages(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "1", 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

/** True when a project short name matches the (case-insensitive) filter. */
function projectMatches(shortName: string, filter: string): boolean {
  return shortName.toLowerCase().includes(filter.toLowerCase());
}

/**
 * The export command core. Reads only the claude dir; writes only under
 * `<home>/exports`. Returns stats (never throws on individual bad files/lines,
 * §5.9). Deterministic and idempotent: same input → byte-identical output.
 */
export function runExport(opts: ExportArgs): ExportStats {
  const out = opts.output ?? process.stdout;
  const write = (line = "") => out.write(`${line}\n`);

  const { home, claudeDir } = resolvePaths(opts);
  const minMessages = parseMinMessages(opts["min-messages"]);
  const exportsDir = path.join(home, "exports");

  const projects = discoverProjects(claudeDir);

  // Apply the --project filter; count the sessions it excludes for reporting.
  let skippedByFilter = 0;
  const selected = projects.filter((project) => {
    if (opts.project && !projectMatches(project.shortName, opts.project)) {
      skippedByFilter += project.sessions.length;
      return false;
    }
    return true;
  });

  // Read every selected session into the corpus input, tolerating read errors.
  const inputs: DedupeInput[] = [];
  let readErrors = 0;
  const readErrorPaths: string[] = [];
  for (const project of selected) {
    for (const session of project.sessions) {
      let content: string;
      try {
        content = fs.readFileSync(session.path, "utf8");
      } catch {
        readErrors++;
        readErrorPaths.push(session.path);
        continue;
      }
      inputs.push({
        project: project.shortName,
        sessionId: session.file.replace(/\.jsonl$/, ""),
        sourcePath: session.path,
        lines: content.split(/\r?\n/),
      });
    }
  }

  // ONE shared dedupe pass (R8) — Task 5's anaphora/outcome passes reuse this.
  const corpus = buildCorpus(inputs);

  // Partition sessions by the min-messages threshold.
  let zeroMessageSessions = 0;
  let belowMinMessages = 0;
  let badLines = 0;
  const eligible: CorpusSession[] = [];
  for (const session of corpus.sessions) {
    badLines += session.badLines;
    const count = session.messages.length;
    if (count === 0) {
      zeroMessageSessions++;
    } else if (count < minMessages) {
      belowMinMessages++;
    } else {
      eligible.push(session);
    }
  }

  // Allocate filenames and render (deterministic corpus order → stable names).
  const used = new Set<string>();
  const manifest: ManifestEntry[] = [];
  const writes: { file: string; content: string }[] = [];
  let totalMessages = 0;
  for (const session of eligible) {
    const file = exportFileName(session.project, session.sessionId, used);
    writes.push({ file, content: renderExport(session) });
    manifest.push({
      export: file,
      source: session.sourcePath,
      project: session.project,
      sessionId: session.sessionId,
      messages: session.messages.length,
      first_ts: session.firstTs,
      last_ts: session.lastTs,
    });
    totalMessages += session.messages.length;
  }

  // Deterministic manifest ordering, rewritten wholesale each run.
  manifest.sort((a, b) => a.export.localeCompare(b.export));

  // Write to disk: mkdir -p, per-session markdown, then the manifest.
  fs.mkdirSync(exportsDir, { recursive: true });
  for (const { file, content } of writes) {
    fs.writeFileSync(path.join(exportsDir, file), content);
  }
  fs.writeFileSync(
    path.join(exportsDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const files = writes.map((w) => w.file).sort();
  const stats: ExportStats = {
    exportedSessions: eligible.length,
    totalMessages,
    duplicatesDropped: corpus.duplicatesDropped,
    skippedByFilter,
    zeroMessageSessions,
    belowMinMessages,
    readErrors,
    badLines,
    exportsDir,
    files,
  };

  reportExport(write, opts, corpus, eligible, stats, minMessages, readErrorPaths);
  return stats;
}

/** Print the summary, the skip/error accounting, and (opt-in) verbose detail. */
function reportExport(
  write: (line?: string) => void,
  opts: ExportArgs,
  corpus: Corpus,
  eligible: CorpusSession[],
  stats: ExportStats,
  minMessages: number,
  readErrorPaths: string[],
): void {
  write(
    `exported ${stats.exportedSessions} sessions (${stats.totalMessages} messages, ` +
      `${stats.duplicatesDropped} duplicates dropped) → ${stats.exportsDir}`,
  );

  // Accounting for everything that did NOT get exported (observability).
  if (stats.skippedByFilter > 0) {
    write(dim(`  ${stats.skippedByFilter} session(s) skipped by --project filter`));
  }
  if (stats.zeroMessageSessions > 0) {
    write(dim(`  ${stats.zeroMessageSessions} session(s) had no human messages (skipped)`));
  }
  if (stats.belowMinMessages > 0) {
    write(
      dim(`  ${stats.belowMinMessages} session(s) below --min-messages ${minMessages} (skipped)`),
    );
  }
  if (stats.readErrors > 0) {
    write(dim(`  ${stats.readErrors} session file(s) could not be read (skipped)`));
  }
  if (stats.badLines > 0) {
    write(dim(`  ${stats.badLines} corrupt JSONL line(s) skipped`));
  }

  if (opts.verbose) {
    write();
    // Every session the corpus saw, with its extractor drops and dedupe count.
    const exportedIds = new Set(eligible.map((s) => s.sessionId));
    for (const session of corpus.sessions) {
      const status = exportedIds.has(session.sessionId)
        ? "exported"
        : session.messages.length === 0
          ? "skipped (no messages)"
          : `skipped (< ${minMessages} messages)`;
      write(
        dim(
          `${session.project}/${session.sessionId}: ${session.messages.length} msg, ` +
            `${session.dedupeDropped} fork-copy dropped, ${session.drops.length} piece(s) dropped ` +
            `[${status}]`,
        ),
      );
      for (const drop of session.drops) {
        write(dim(`    drop ${drop.reason}: ${drop.snippet}`));
      }
    }
    for (const p of readErrorPaths) {
      write(dim(`read error: ${p}`));
    }
  }

  write(hint("cc-hindsight distill"));
}

export default defineCommand({
  meta: {
    name: "export",
    description: "Export human-only session markdown + manifest",
  },
  args: {
    ...sharedArgs,
    project: { type: "string", description: "Only export sessions from this project" },
    "min-messages": {
      type: "string",
      default: "1",
      description: "Minimum human messages for a session to be exported",
    },
    verbose: { type: "boolean", description: "Report every dropped piece and dedupe drop" },
  },
  run({ args }) {
    runExport(args as unknown as ExportArgs);
  },
});
