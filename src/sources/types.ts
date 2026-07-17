/**
 * sources/types.ts — the source-agnostic currency of the pipeline.
 *
 * A cc-hindsight backend (Claude Code, kiro-cli, …) is a {@link SessionSource}:
 * it discovers sessions in its own on-disk store and turns each session's raw
 * lines into the SAME three artifacts every downstream stage consumes —
 * {@link ExtractedMessage}s (with observable {@link Drop}s), and a
 * {@link TimelineEvent} stream. Once a source has produced these, NOTHING
 * downstream (dedupe, anaphora, outcome, render, distill) parses raw lines
 * again; the seam lives entirely here.
 *
 * These types were previously defined in `src/core/extract.ts` and
 * `src/core/discover.ts`; they moved here so both the Claude and kiro adapters
 * can depend on one shared vocabulary without importing each other.
 */

/** Which backend a session came from. */
export type SourceName = "claude" | "kiro";

/**
 * A recovered human message. `text` may join multiple surviving pieces with a
 * blank line and may include rendered `[decision]` / `[command]` /
 * `[image pasted]` lines (Claude Code) — kiro sources omit surfaces they cannot
 * produce.
 */
export interface ExtractedMessage {
  /** Source entry timestamp; "" when the entry had none (tolerated). */
  timestamp: string;
  text: string;
}

/** An observable record of a piece/entry that was dropped, for `--verbose`. */
export interface Drop {
  /** Rule + cause, e.g. "R6: machine block (leading <)" or "K6: bracket marker". */
  reason: string;
  /** Whitespace-collapsed excerpt, ≤120 chars. */
  snippet: string;
  /** Source entry timestamp when present. */
  timestamp?: string;
}

/** The result of extracting one session's human messages. */
export interface ExtractResult {
  messages: ExtractedMessage[];
  drops: Drop[];
  /** Count of corrupt/unparseable lines skipped (never aborts). */
  badLines: number;
}

/**
 * A single event on a session file's linear timeline. Beyond the human turns
 * the anaphora/outcome passes need the assistant's side of the conversation to
 * resolve what short human turns like "yes" or "option 2" referred to:
 *   - `human`:     a human turn (text identical to the extracted message);
 *   - `assistant`: an assistant *text* turn (the antecedent candidate);
 *   - `plan`:      an `ExitPlanMode`-style tool surface — what a bare "yes" approved;
 *   - `question`:  an `AskUserQuestion`-style surface, rendered compactly;
 *   - `boundary`:  a hard context reset (`/clear`, `/compact`) — an antecedent
 *                  must never be resolved across it, because the model never
 *                  saw the pre-boundary text either. Claude Code emits none
 *                  today; kiro emits it for `Clear`/`Compaction` entries.
 *
 * Events are in file order. Timestamps are copied from the source entry (""
 * when absent, tolerated as elsewhere).
 */
export type TimelineEvent =
  | { kind: "human"; timestamp: string; text: string }
  | { kind: "assistant"; timestamp: string; text: string }
  | { kind: "plan"; timestamp: string; text: string }
  | { kind: "question"; timestamp: string; text: string }
  | { kind: "boundary"; timestamp: string; text: string };

/** A single session transcript discovered in a backend's store. */
export interface SessionInfo {
  /** File name on disk, e.g. `01ab...ef.jsonl`. */
  file: string;
  /** Absolute path to the session file. */
  path: string;
  /**
   * Cheap entry count: number of non-empty newline-delimited lines. Each JSONL
   * line is one transcript entry; we deliberately do NOT `JSON.parse` per line
   * (that would be O(entries) parses just to inventory the machine).
   */
  entryCount: number;
  /** File modification time — a proxy for "last touched". */
  mtime: Date;
}

/** A project: one logical grouping of sessions (a Claude project dir / a kiro cwd). */
export interface ProjectInfo {
  /** Raw, on-disk directory name (Claude: dash-encoded dir; kiro: n/a). */
  dirName: string;
  /** Best-effort decoded filesystem path. */
  decodedPath: string;
  /**
   * Short, human-friendly name: the last segment of the decoded path,
   * deduplicated across the result set.
   */
  shortName: string;
  /** Sessions belonging to this project. */
  sessions: SessionInfo[];
  /** Sum of {@link SessionInfo.entryCount} across all sessions. */
  entryTotal: number;
  /** Latest activity: max session mtime, or `undefined` for an empty project. */
  latestMtime: Date | undefined;
}

/**
 * A backend that can discover sessions and turn their raw lines into the shared
 * currency. The three methods carry a single law downstream depends on:
 *
 *   Every message in `extract(lines).messages` MUST appear as a `human`
 *   {@link TimelineEvent} from `timeline(lines)` with an identical
 *   `(timestamp, text)`, in file order.
 *
 * The dedupe key and the anaphora↔export index alignment both depend on the two
 * paths agreeing exactly; a backend satisfies the law by producing both message
 * texts from one shared per-entry function.
 */
export interface SessionSource {
  readonly name: SourceName;
  /** Enumerate projects+sessions in this backend's store; missing store → []. */
  discover(opts?: { countEntries?: boolean }): ProjectInfo[];
  /** Fidelity contract: raw lines → human messages + observable drops. */
  extract(lines: string[]): ExtractResult;
  /** Full-conversation timeline for anaphora/outcome context. */
  timeline(lines: string[]): TimelineEvent[];
  /**
   * Optional session-level classification from store metadata: `"automation"`
   * excludes the whole session (kiro subagent/naming/consolidation sessions),
   * `"interactive"`/undefined keeps it. Claude Code classifies per-entry inside
   * `extract` and needs no session-level pass.
   */
  classify?(session: SessionInfo & { project: string }): "interactive" | "automation" | undefined;
}
