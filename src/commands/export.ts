import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { defineCommand } from "citty";
import {
  type AnaphoraRecord,
  buildAnaphora,
  SHORT_TURN_MAX_WORDS,
  TAIL_CHARS,
} from "../core/anaphora.js";
import { buildCorpus, type Corpus, type CorpusSession, type DedupeInput } from "../core/dedupe.js";
import { mkdirPrivate, writeFilePrivate } from "../core/fsutil.js";
import { buildOutcome, FINAL_TURNS, OUTCOME_NOTE, type OutcomeEvidence } from "../core/outcome.js";
import { exportFileName, renderExport } from "../core/render.js";
import { claudeSource } from "../sources/claude/index.js";
import type { TimelineEvent } from "../sources/types.js";
import { dim, hint } from "../ui/style.js";
import { parseClampedInt, resolvePaths, sharedArgs } from "./_shared.js";

/** One entry of `exports/manifest.json`. */
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
  /** Case-insensitive substring filter on project short name. */
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
  /** Messages dropped as cross-file fork copies (dedupe rule R8). */
  duplicatesDropped: number;
  /** Sessions excluded by the `--project` filter. */
  skippedByFilter: number;
  /** Sessions with zero surviving human messages (skipped naturally). */
  zeroMessageSessions: number;
  /** Sessions with some messages but fewer than `--min-messages`. */
  belowMinMessages: number;
  /** Session files that could not be read (skipped, tolerated). */
  readErrors: number;
  /** Corrupt JSONL lines skipped across all sessions. */
  badLines: number;
  /** Short human turns (≤15 words) attached with anaphora context. */
  shortTurns: number;
  /** Of those, how many had a pending plan/question decision surface. */
  shortTurnsWithDecision: number;
  /** Sessions that captured a non-empty final assistant tail (real outcome evidence). */
  outcomeSessions: number;
  /** Absolute path to the exports directory that was written. */
  exportsDir: string;
  /** Stale `.md` files pruned (unfiltered runs only) because their session is gone. */
  prunedExports: number;
  /** Written markdown basenames, sorted (manifest.json excluded). */
  files: string[];
}

/** Whitespace-collapse and cap a short human turn for a one-line verbose row. */
function snippetOneLine(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/** True when a project short name matches the (case-insensitive) filter. */
function projectMatches(shortName: string, filter: string): boolean {
  return shortName.toLowerCase().includes(filter.toLowerCase());
}

/**
 * The export command core. Reads only the claude dir; writes only under
 * `<home>/exports`. Returns stats — individual bad files/lines are tolerated
 * and counted, never thrown. Deterministic and idempotent: same input →
 * byte-identical output.
 */
export function runExport(opts: ExportArgs): ExportStats {
  const out = opts.output ?? process.stdout;
  const write = (line = "") => out.write(`${line}\n`);

  const { home, claudeDir } = resolvePaths(opts);
  const minMessages = parseClampedInt(opts["min-messages"], { fallback: 1, min: 1 });
  const exportsDir = path.join(home, "exports");

  // The Claude Code backend as a SessionSource. Extraction and timeline both
  // run through it, so the seam is uniform (kiro plugs in the same way).
  const source = claudeSource(claudeDir);

  // Entry counts are unused by export (content is read below); skip the count
  // read so each session file is read at most once for this command.
  const projects = source.discover({ countEntries: false });

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
  // Extraction runs through the source here; the timeline is deferred to a lazy
  // per-source thunk keyed by the unique source path, so the anaphora/outcome
  // passes below walk the SAME lines through the SAME source (the SessionSource
  // law — extract↔timeline agreement — is what keeps index alignment sacred).
  const inputs: DedupeInput[] = [];
  const timelineOf = new Map<string, () => TimelineEvent[]>();
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
      const lines = content.split(/\r?\n/);
      inputs.push({
        project: project.shortName,
        sessionId: session.file.replace(/\.jsonl$/, ""),
        sourcePath: session.path,
        extracted: source.extract(lines),
      });
      timelineOf.set(session.path, () => source.timeline(lines));
    }
  }

  // ONE shared dedupe pass (rule R8) — anaphora/outcome reuse this exact
  // corpus so their record indices align with the rendered export exactly.
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

  // Allocate filenames, render, and run the anaphora + outcome passes per
  // exported session (deterministic corpus order → stable names).
  const used = new Set<string>();
  const manifest: ManifestEntry[] = [];
  const writes: { file: string; content: string }[] = [];
  const anaphoraByFile: Record<string, AnaphoraRecord[]> = {};
  const outcomesByFile: Record<string, OutcomeEvidence> = {};
  const attached: AttachedSession[] = [];
  let totalMessages = 0;
  let shortTurns = 0;
  let shortTurnsWithDecision = 0;
  let outcomeSessions = 0;
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

    const timeline = timelineOf.get(session.sourcePath)?.() ?? [];
    const records = buildAnaphora(session, timeline);
    anaphoraByFile[file] = records;
    const outcome = buildOutcome(session, timeline);
    outcomesByFile[file] = outcome;
    if (outcome.final_assistant_tail !== "") outcomeSessions++;
    shortTurns += records.length;
    shortTurnsWithDecision += records.filter((r) => r.decision_kind !== null).length;
    attached.push({ file, project: session.project, sessionId: session.sessionId, records });
  }

  // Deterministic manifest ordering, rewritten wholesale each run.
  manifest.sort((a, b) => a.export.localeCompare(b.export));

  // Deterministic (sorted-by-export-name) anaphora + outcome objects. outcomes
  // gets a leading `_note` labeling the assistant text as machine-authored.
  const anaphoraOut: Record<string, AnaphoraRecord[]> = {};
  for (const file of Object.keys(anaphoraByFile).sort()) {
    anaphoraOut[file] = anaphoraByFile[file] ?? [];
  }
  const outcomesOut: Record<string, unknown> = { _note: OUTCOME_NOTE };
  for (const file of Object.keys(outcomesByFile).sort()) {
    outcomesOut[file] = outcomesByFile[file];
  }

  // Write to disk: mkdir -p (owner-only), per-session markdown, then the JSON
  // artifacts — all with owner-only permissions (they can contain secrets).
  mkdirPrivate(exportsDir);
  for (const { file, content } of writes) {
    writeFilePrivate(path.join(exportsDir, file), content);
  }
  writeFilePrivate(
    path.join(exportsDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFilePrivate(
    path.join(exportsDir, "anaphora.json"),
    `${JSON.stringify(anaphoraOut, null, 2)}\n`,
  );
  writeFilePrivate(
    path.join(exportsDir, "outcomes.json"),
    `${JSON.stringify(outcomesOut, null, 2)}\n`,
  );

  // Prune stale exports: `.md` files from a previous run whose session no
  // longer exists (deleted/renamed under ~/.claude). ONLY on an unfiltered,
  // default-threshold run — otherwise the current write set is a deliberate
  // subset and the "missing" files are valid entries from other scopes.
  let prunedExports = 0;
  if (!opts.project && minMessages === 1) {
    const kept = new Set(writes.map((w) => w.file));
    for (const f of fs.readdirSync(exportsDir)) {
      if (f.endsWith(".md") && !kept.has(f)) {
        fs.rmSync(path.join(exportsDir, f), { force: true });
        prunedExports++;
      }
    }
  }

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
    shortTurns,
    shortTurnsWithDecision,
    outcomeSessions,
    exportsDir,
    prunedExports,
    files,
  };

  reportExport(write, opts, corpus, eligible, stats, minMessages, readErrorPaths, attached);
  return stats;
}

/** Per-exported-session anaphora attachment info, for the summary + --verbose. */
interface AttachedSession {
  file: string;
  project: string;
  sessionId: string;
  records: AnaphoraRecord[];
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
  attached: AttachedSession[],
): void {
  write(
    `exported ${stats.exportedSessions} sessions (${stats.totalMessages} messages, ` +
      `${stats.duplicatesDropped} duplicates dropped) → ${stats.exportsDir}`,
  );

  // Anaphora + outcome accounting.
  write(
    `${stats.shortTurns} short turns attached ` +
      `(${stats.shortTurnsWithDecision} had a pending plan/question); ` +
      `outcome evidence captured for ${stats.outcomeSessions} sessions`,
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
  if (stats.prunedExports > 0) {
    write(dim(`  ${stats.prunedExports} stale export(s) pruned (session no longer exists)`));
  }

  if (opts.verbose) {
    write();
    write(
      dim(
        `bounded evidence: short turns ≤ ${SHORT_TURN_MAX_WORDS} words get context; ` +
          `antecedent/assistant tails ≤ ${TAIL_CHARS} chars; last ${FINAL_TURNS} human turns captured per session.`,
      ),
    );
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

    // Attached short turns per exported session (index, text, plan/question).
    for (const session of attached) {
      if (session.records.length === 0) continue;
      write(
        dim(
          `${session.project}/${session.sessionId}: ${session.records.length} short turn(s) attached`,
        ),
      );
      for (const record of session.records) {
        const decision = record.decision_kind ? ` +${record.decision_kind}` : "";
        const antecedent = record.antecedent ? " +antecedent" : "";
        write(
          dim(
            `    #${record.index} "${snippetOneLine(record.human_text)}"${antecedent}${decision}`,
          ),
        );
      }
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
