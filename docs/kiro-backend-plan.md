# cc-hindsight × kiro-cli — Full Compatibility Plan

> Make `cc-hindsight` (npm, v1.0.2) mine **kiro-cli** session history the way it
> mines Claude Code history today: scan → export → distill → oneshot library +
> preferences, with kiro-cli as both the *data source* and the *LLM runner*.

| | |
|---|---|
| Status | **v1.0 — review-hardened, implementation-ready** |
| Date | 2026-07-15 |
| Source analyzed | github.com/adityaarunsinghal/cc-hindsight @ main (v1.0.2) |
| Target analyzed | kiro-cli on this machine, v2 file-based session store |
| Evidence base | Full source read; 267 real kiro sessions (6,423 log entries, 46.9 MB) census-parsed; live headless probes (stdin/agent/cleanup/size) |

## Changelog

- **v1.0** (2026-07-15): Adversarial review (opus) integrated. High-severity
  fixes inline: K2 rewritten with explicit precedence (`.history` overrides
  exclusions; boilerplate-first markers added; hybrid rewind/agent-spawned
  sessions with human steering now included); pseudo-timestamps **rejected**
  (upstream-parity `""` + optional session-scoped dedupe key); runner session
  cleanup gains a hard deletion-safety invariant (delete only scratch-cwd
  group + sentinel-title match; one per-run scratch dir, concurrency-safe);
  upstream delivery split (issue → refactor-only PR → read-side PR →
  runner/outputs PR). Remaining deltas consolidated in §12: consolidate-runner
  threading, five branded copy surfaces, `Clear`/`Compaction` as anaphora
  boundaries, snapshot-only-prompt Drop observability, orphan `.history`
  surfacing, `KIRO_CONFIG_DIR` naming unification, fixture list expansion,
  accepted-risk register, and two explicitly rejected suggestions.
- **v0.4** (2026-07-15): Commit-by-commit refactor spec (§11, opus subagent,
  spot-verified) integrated: exact signature diffs, shim strategy with the 7
  test files needing them, `origin` manifest field (avoids collision with the
  existing `source` path field), `--source auto` threading incl. prune-guard
  fix, AgentRunner split (shared corrective retry vs kiro empty-stdout backoff
  layering), 7-commit map with LoC and risk analysis. Integrator annotations
  §11.A correct the spec's temp-cwd cleanup misconception (store is flat;
  verified recipe = per-cwd list + delete), harden pseudo-timestamps, and
  make the runner registry default `auto`.
- **v0.3** (2026-07-15): Full-store forensic census (opus subagent; 816 files /
  46.9 MB / 6,423 entries) integrated. Corrections: the inline
  `--- USER MESSAGE BEGIN ---` wrapper cases are **false positives** (quoted
  inside orchestrated task text, no END marker) → K6 wrapper-recovery rule
  **dropped**; `.history` is a near-perfect human marker (27/27 validated, only
  6 false-negative sessions, all harness retry strings); duplication confirmed
  rewind-only (3 keys, one parent-linked pair); `session_state` carries
  **per-session `model_info` + `agent_name`** (useful provenance); tool
  results can rarely embed images (1/3,071 — skip); Compaction snapshots
  reuse the normal block vocabulary; `.history` encodes multi-line prompts
  with literal `\n` escapes and includes slash commands.
- **v0.2** (2026-07-15): Live probes resolved OPEN-1/2/3: stdin delivery works
  incl. 150 KB (needle verified); `tools: []` local agent suppresses all tools
  (`TOOLS=NONE`); local `.kiro/agents/` cwd-discovery works for `--agent`;
  headless runs (even failed ones) persist sessions — `--list-sessions` +
  `--delete-session` cleanup verified end-to-end. **New failure mode found:**
  transient backend errors return **exit 0 with empty stdout** and "Kiro is
  having trouble responding" on stderr — the runner must treat empty stdout as
  a retryable failure and add bounded retry-with-backoff. Probe artifacts
  cleaned from the session store.
- **v0.1** (2026-07-15): Initial draft from full source read + on-machine kiro-cli
  store analysis + first headless probes. Open items 1–4 unresolved.

---

## 1. Goal and scope

**Goal:** a user whose agent history lives in kiro-cli gets the identical
product experience: inventory their sessions, export human-only markdown,
distill a oneshot prompt library, and emit a paste-ready preferences block —
without losing any of cc-hindsight's fidelity/consent/provenance contracts.

**In scope**
- kiro-cli **v2 session store** (`~/.kiro/sessions/cli/*.jsonl` + companions).
- kiro-cli as the **distill runner** (`kiro-cli chat --no-interactive`).
- Preferences output targeting kiro conventions (steering files / AGENTS.md).
- Multi-backend coexistence: Claude Code support keeps working unchanged.

**Out of scope (v1)**
- Legacy v1 sqlite store (`~/.local/share/kiro-cli/data.sqlite3`,
  `conversations`/`conversations_v2` tables — empty on the reference machine).
- Windows (upstream cc-hindsight is macOS/Linux only).
- kiro IDE (non-CLI) session sources.

---

## 2. cc-hindsight architecture (as-built) and its coupling surfaces

Pipeline: `scan` → `export` (deterministic) → `distill` (consent-gated LLM:
digest 1/session → cluster 1 total → author 1/task) → library verbs
(`list/show/copy/edit/rate/prune/status`) + `preferences`.

Only **five surfaces** touch Claude Code specifics. Everything else —
dedupe algorithm, anaphora, outcome evidence, budget/truncation, render,
checkpoints/generations, consent gate, library storage, browsing verbs,
preference aggregation — is already backend-agnostic.

| # | Surface | Module(s) | Claude Code specifics |
|---|---------|-----------|----------------------|
| S1 | Discovery | `core/discover.ts` | `<claudeDir>/projects/<dash-encoded-cwd>/*.jsonl`; lossy dash decoding; top-level-files-only excludes subagent threads |
| S2 | Extraction | `core/extract.ts` | Entry shapes: `type: user\|assistant\|attachment`; flags `isMeta/isSidechain/isCompactSummary/isVisibleInTranscriptOnly/entrypoint`; blocks `text\|image\|document\|tool_result\|tool_use`; `toolUseResult.questions`; `<command-name>` XML; `"the user said:"` marker; interruption markers (rules R1–R7, R10, R11) |
| S3 | Timeline (anaphora/outcome) | `core/extract.ts#extractTimeline` | Assistant text turns; `ExitPlanMode` plan and `AskUserQuestion` question tool_use surfaces |
| S4 | LLM runner | `claude/runner.ts` | `claude -p --output-format json [--json-schema] [--tools ""] [--model]`; JSON envelope `{type,is_error,result}`; capability probe via `--help`; prompt on stdin |
| S5 | Preferences target | `core/preferences.ts`, `commands/preferences.ts` | Renders a `CLAUDE.md` block |

Cross-cutting Claude-isms: flag/env names (`--claude-dir`,
`CLAUDE_CONFIG_DIR`), install hint, prompt copy ("Claude Code session",
`[decision]`/`[command]`/`[image pasted]` legend), README/docs.

### 2.1 Contracts that must survive the port

1. **Fidelity contract** — every dropped piece is an observable `Drop` under
   `--verbose`; false drops are bugs; per-rule regression fixtures.
2. **Determinism contract** — scan/export are LLM-free, idempotent,
   byte-stable; same input → byte-identical output.
3. **Consent contract** — exact invocation counts disclosed pre-spend;
   `--dry-run` free; decline = exit 2, nothing invoked; oversized input
   blocked pre-spend unless `--truncate=extreme` (disclosed + recorded).
4. **Provenance contract** — generation ids, prompt versions, model, input
   coverage, truncations recorded in `sources.json`; user-edit hash protection.
5. **Privacy contract** — local-only; owner-only file modes (0600/0700); the
   only network path is the user's own agent CLI.
6. **Alignment contract** — post-dedupe message `index` aligns export
   markdown, `anaphora.json`, and `outcomes.json` byte-for-byte.

---

## 3. kiro-cli facts (verified on this machine)

### 3.1 Session store (v2, file-based) — replaces S1's assumptions

Location: `~/.kiro/sessions/cli/` — **flat**, all projects together
(confirmed by docs: auto-saved every turn, per-directory scoping via metadata).

| File | Content |
|------|---------|
| `<uuid>.jsonl` | Append-only event log; one `{version:"v1", kind, data}` JSON object per line |
| `<uuid>.json` | Metadata: `session_id`, `cwd`, `created_at`/`updated_at` (ISO-8601), `title`, `session_created_reason`, `parent_session_id?`, `session_state{agent_name, permissions, …}` |
| `<uuid>.history` | Readline prompt history — exists only where a human typed (32 files; 27 with live transcripts + 5 orphans) |
| `<uuid>.lock` | Present while session is active |
| `<uuid>/tasks/*.json` | Todo-list sidecar (subdirectory per session) |

Observed census (full-store forensic pass): 816 files / 46.9 MB; 267 sessions
(1:1 metadata companions), 6,423 log entries — **all** `version:"v1"`, **zero**
parse failures; 32 `.history`; 8 session-id subdirs (todo-task sidecars, not
transcripts); 28+ distinct `cwd` values.

### 3.2 Event vocabulary (from all 6,423 entries)

| kind | count | data shape |
|------|-------|-----------|
| `Prompt` | 410 | `{message_id, content: [{kind:"text", data:<string>}], meta?: {timestamp:<unix-seconds int>, additionalContext?:<string>}}` — meta absent on 30 |
| `AssistantMessage` | 3,210 | `{message_id, content: [{kind: text\|toolUse\|thinking, data}]}` |
| `ToolResults` | 2,800 | `{message_id, content: [{kind: toolResult\|text}], results: {<toolUseId>: …}}` — `toolResult.data.content[]` items are `json` (2,098) \| `text` (1,302) \| `image` (1 — raw bytes; skip) |
| `Clear` | 2 | `data: null` (`/clear` boundary) |
| `Compaction` | 1 | `{summary, strategy, messages_snapshot}` — snapshot items `{id, role: user\|assistant, content: <normal block list>, meta?}` duplicate earlier same-file entries |

Key properties:
- The human's typed text lands **verbatim** in `Prompt.content[].data`;
  injected context goes to `meta.additionalContext` (237/410; always starts
  `--- CONTEXT ENTRY BEGIN ---`; **never** contains the human's own message —
  verified 0/237 — so it is always safe to drop).
- ~~Inline `USER MESSAGE BEGIN` wrappers~~ — census correction: the 2 apparent
  cases are **false positives** (the marker was *quoted inside* orchestrated
  task text, no END marker present). No wrapper-recovery rule is needed.
- **Timestamps**: only `Prompt.meta.timestamp` (unix seconds, int); missing on
  30/410. Assistant/tool entries carry none. Session-level `created_at`/
  `updated_at` in the companion metadata.
- Tool denial/cancel is machine text inside `ToolResults`:
  `"Tool use was cancelled by the user"`, `"Tool use was rejected because the
  arguments supplied are forbidden: <regex>"` — the human's follow-up is a
  **new Prompt entry** (no Claude-style `"the user said:"` piggyback).
- Slash commands are client-side: they appear in `.history` (e.g. `/model`)
  but never in the transcript. `/clear` → `Clear` entry; `/compact` →
  `Compaction` entry.
- No image/document blocks observed in any `Prompt` (0/410).

### 3.3 Human-vs-automation discrimination (replaces R2)

- `session_created_reason` is **unreliable**: says `"subagent"` even for
  interactive human sessions (verified against the live session that produced
  this document). Do not use.
- Reliable signals found (validated against the full store):
  - `.history` file exists → human typed here. **Near-perfect**: all 27
    history-sessions (with transcripts) contain ≥1 genuine human prompt; only
    6 history-less sessions contain "human-looking" prompts and **all six are
    harness retry strings** ("The generated tool was too large…", "You took
    too long to respond…") — i.e. zero real false negatives once those two
    enumerable strings are filtered.
  - `parent_session_id` present → spawned child (subagent/rewind) (17/267).
  - First `Prompt` starts `[AGENT SYSTEM PROMPT]` → automation harness
    injected a system prompt as user content.
  - Automation boilerplate first lines: "You are a session naming agent…",
    "You are a memory consolidation agent…", "You are generating contextual
    prompt suggestions…".
  - Machine-injected mid-session prompts: `[Recent channel messages for
    context:]`, `[Subagent completion event]`, "The generated tool was too
    large…", "You took too long to respond…", "You have not called the summary
    tool yet…".
- **Provenance bonus**: `session_state.rts_model_state.model_info` carries the
  per-session `model_id`/`model_name` and `session_state.agent_name` the agent
  — kiro sources can fill `sources.json` provenance richer than Claude Code
  (per-member model attribution).
- `.history` format: plain text, one prompt per line, multi-line prompts
  encoded with literal `\n` escapes, **includes slash commands** (`/agent`,
  `/model`, `/effort`) — a classification signal only, never an extraction
  source (transcript text is authoritative).
- Subagent transcripts live in the **same flat directory** — Claude Code's
  "top-level files only" exclusion has no kiro equivalent; session-level
  classification is required.

### 3.4 Duplication vectors (dedupe R8 still needed)

- **rewind — confirmed as the sole in-store duplication vector**: exactly 3
  duplicated `(timestamp, text)` keys store-wide, all within one parent-linked
  pair whose child is the only `session_created_reason:"rewind"` session. The
  16 subagent parent-links share **zero** duplicate keys.
- **`/chat load`**: docs confirm a loaded session gets a *new UUID* with
  copied log entries (`imported_from` set) — second vector, not present in
  this store but must be handled.
- `Compaction.messages_snapshot` duplicates earlier entries **within the same
  file** — must be ignored by extraction, not deduped.

### 3.5 Headless invocation (live-probed)

`kiro-cli chat --no-interactive [--agent X] [--model Y] [--effort E] [INPUT]`

- Probe: `kiro-cli chat --no-interactive --trust-tools= 'Reply with exactly
  the word OK…'` → exit 0; stdout = `ESC[38;5;141m> ESC[0mOK` (**ANSI escapes
  + `> ` prefix survive redirection**); stderr carries a credits/time footer
  (`▸ Credits: 0.32 • Time: 4s`).
- No `--output-format json` for chat responses; no `--json-schema`; no
  `--tools` flag (tools come from agent configs; `--trust-tools` only gates
  approval and warns on empty value).
- **stdin delivery verified**: piping the prompt via stdin works for
  multi-line prompts and up to **150 KB** (tail-needle passphrase echoed back;
  exit 0, credits charged). argv also works ≤ ~128 KiB but is unnecessary.
- **`tools: []` verified**: a local agent (`<cwd>/.kiro/agents/<name>.json`)
  with `"tools": [], "mcpServers": {}` is discovered from the spawn cwd via
  `--agent <name>` and the model reports `TOOLS=NONE` — full tool suppression,
  no MCP startup.
- **Failure mode (critical for runner design)**: transient backend errors
  ("Kiro is having trouble responding … Failed to receive the next message")
  print to **stderr**, leave **stdout empty**, and still **exit 0**. Observed
  in a burst across sizes/agents/models, then the identical invocations
  succeeded on retry. ⇒ empty/JSON-less stdout must be treated as retryable
  regardless of exit code, with bounded backoff.
- stderr also carries non-fatal noise: agent-duplication warnings, spinner
  control sequences, and the credits footer.
- **Session persistence verified**: every headless run — including failed
  ones — persists a session in the store keyed to the spawn cwd;
  `--list-sessions --format json` (per-cwd) + `--delete-session <id>` clean
  them up reliably (verified: created → listed → deleted → empty).
- `--list-models --format json` → `{models:[{model_id, context_window_tokens,
  rate_multiplier, …}]}`; models incl. `auto`, `claude-sonnet-5`,
  `claude-opus-4.8` (1M-token context windows).
- `--list-sessions --format json` (per-cwd) → `[{cwd, sessions:[{sessionId,
  source:"v1"|"v2", title, updatedAt, messageCount}]}]`.
- `--delete-session <id>` and `--session-source v1|v2` exist.
- Every chat run **auto-saves a new session** into the store (docs: "every
  conversation turn saved") — see the feedback-loop risk in §5.4.

### 3.6 Output-side conventions (S5 target)

- Steering files: `~/.kiro/steering/**/*.md` (global) and `.kiro/steering/**/*.md`
  (workspace), auto-loaded by the default agent; custom agents inherit them
  (plus `AGENTS.md`, `README.md`, skills) unless
  `chat.disableInheritingDefaultResources=true` (global setting).
- Agent configs: `.kiro/agents/<name>.json` (local, cwd-discovered) or
  `~/.kiro/agents/<name>.json` (global): `{name, description, prompt, tools,
  allowedTools, toolsSettings, resources, hooks, mcpServers, model, …}`.
- `KIRO_SESSION_ID` env var is exported to child processes of a session.

---

## 4. Architecture decision: multi-backend via a post-extraction seam

**Decision: multi-backend, not a fork.** Add a `--source claude|kiro|auto`
dimension; keep the package as one tool. Rationale: ~90% of the code is
source-agnostic, the fixture regime ports cleanly, and a fork would bitrot.

**The seam sits *after* extraction, not at raw lines.** Kiro lines are not
Claude lines; sharing `extract.ts` is impossible. But `ExtractedMessage`,
`Drop`, and `TimelineEvent` are already source-neutral. Define:

```ts
/** One discovered session, source-agnostic. */
interface SourceSession {
  project: string;        // kiro: basename(metadata.cwd); claude: decoded dir
  projectPath: string;    // kiro: metadata.cwd; claude: decoded path
  sessionId: string;      // file stem (uuid)
  sourcePath: string;     // absolute .jsonl path
  mtime: Date;
  entryCount: number;     // cheap line count (scan only)
}

interface SessionSource {
  id: "claude" | "kiro";
  discover(rootDir: string, opts?): SourceProject[];       // groups SourceSession
  extract(lines: string[], meta?): ExtractResult;          // messages+drops+badLines
  timeline(lines: string[], meta?): TimelineEvent[];       // human/assistant/plan/question
  classifySession?(meta): { include: boolean; reason: string };  // kiro-only, session-level R2
}
```

Unchanged and shared: `dedupe.buildCorpus` (small refactor: accept
pre-extracted messages instead of calling `extractMessages` itself),
`anaphora.buildAnaphora` / `outcome.buildOutcome` (accept a `TimelineEvent[]`
instead of raw lines), `render.ts`, `budget.ts`, the entire distill pipeline,
checkpoints, consent, library, preferences aggregation, all browsing verbs.

Same shape for the runner:

```ts
interface AgentRunner {
  id: "claude" | "kiro";
  probe(): Promise<Capabilities>;   // kiro: binary presence; jsonSchema:false
  run<T>(opts: RunClaudeOptions<T>): Promise<T>;
  installHint: string;
}
```

`--source auto` (default): include every backend whose store directory exists;
merge corpora (session ids are uuids in both; export filenames already
collision-handled). Dedupe stays global across backends — harmless, since
(timestamp,text) collisions across tools are exactly the fork-copy semantics.

Proposed layout (minimal-diff):

```
src/sources/types.ts        # SessionSource, SourceSession, SourceProject
src/sources/claude/…        # move discover.ts + extract.ts (re-export shims keep tests green)
src/sources/kiro/discover.ts
src/sources/kiro/extract.ts # K-rules + timeline
src/runners/types.ts        # AgentRunner
src/runners/claude.ts       # today's claude/runner.ts
src/runners/kiro.ts         # NEW
```

---

## 5. Work items

### 5.1 W1 — kiro discovery adapter (S1)

- Enumerate `~/.kiro/sessions/cli/*.jsonl`; pair each with `<uuid>.json`
  metadata; tolerate missing/corrupt metadata (fall back to flat "unknown"
  project, count as a warning).
- Project identity = metadata `cwd` (exact, lossless — no dash-decode
  heuristics). Short name = `basename(cwd)`, reuse existing deterministic
  disambiguation. Keep sessions of deleted cwds (history still valuable).
- Ignore `*.lock`, `*.history`, `<uuid>/tasks/` sidecars for discovery;
  record `.history` presence as a classification signal.
- New flag/env: `--kiro-dir` / `KIRO_CONFIG_DIR` pointing at the kiro config
  root (default `~/.kiro`; sessions read from `<kiro-dir>/sessions/cli`) —
  one naming scheme everywhere (supersedes earlier `KIRO_DIR` mentions),
  parallel to `--claude-dir` / `CLAUDE_CONFIG_DIR`. `--claude-dir` keeps its
  meaning under `--source kiro` (simply unused), documented.
- `entryCount` reuses the cheap chunked line counter.

### 5.2 W2 — kiro extraction: the K-rule set (S2)

| Claude rule | kiro equivalent | Fixture |
|---|---|---|
| R1 admission (`user`/`attachment` entries) | **K1**: `kind === "Prompt"` entries only | `k1-prompt.jsonl` |
| R2 rejection (entry flags) | **K2 (session-level, explicit precedence)**: (1) `.history` exists alongside the transcript → **INCLUDE** (human typed here — overrides every exclusion; covers hybrid sessions: agent-spawned or rewind children where a human later steered); (2) else `parent_session_id` set → EXCLUDE; (3) else first Prompt matches an automation marker — `[AGENT SYSTEM PROMPT]` **or** boilerplate first lines ("You are a session naming agent…", "You are a memory consolidation agent…", "You are generating contextual prompt suggestions…") → EXCLUDE; (4) else → INCLUDE + verbose classification note (recall-oriented default). Excluded sessions are reported with their reason under `--verbose`. Machine turns *inside* included hybrid sessions are handled per-piece by K6 | `k2-*.jsonl` + metadata/history companion triples |
| R3 queued_command attachments | N/A — no attachment entry kind observed | — |
| R4 string content | **K4**: `content[].kind==="text"` → `data` | `k1-prompt.jsonl` |
| R5 `"the user said:"` recovery | N/A — human follow-up is its own Prompt; cancel/deny text lives in ToolResults (never a candidate) | `k5-cancelled-tool.jsonl` (negative) |
| R6 machine blocks | **K6**: drop pieces with leading `<` (e.g. `<agent-sop>`); drop bracket markers `[AGENT SYSTEM PROMPT]`, `[Recent channel messages for context:]`, `[Subagent completion event]`; drop harness nudges ("The generated tool was too large…", "You took too long to respond…", "You have not called the summary tool…"). *(Census correction: no `USER MESSAGE BEGIN` wrapper-recovery — the observed cases were markers quoted inside orchestrated task text)* | `k6-*.jsonl` |
| R7 AskUserQuestion decisions | N/A — no structured question tool; decision surfaces degrade to null | — |
| R10 `<command-name>` recovery | N/A — slash commands never reach the transcript | — |
| R11 image placeholders | Not observed; keep tolerant parsing; placeholder if a non-text Prompt block kind ever appears | `k11-unknown-block.jsonl` |
| — | **K12 (new)**: ignore `Clear`; ignore `Compaction` entirely (its `messages_snapshot` duplicates same-file entries); never read `meta.additionalContext`; never extract from `ToolResults`/`AssistantMessage` as human text | `k12-compaction.jsonl` |
| — | **K13 (new)**: self-recognition — drop sessions whose first Prompt carries the cc-hindsight distill sentinel header (see W4 feedback-loop guard) | `k13-self.jsonl` |

Timeline (S3): `human` events from admitted Prompt text; `assistant` events
from `AssistantMessage` text blocks (buffer, flush around `toolUse`, skip
`thinking`); no `plan`/`question` events (no ExitPlanMode/AskUserQuestion
equivalents) — anaphora antecedents still work, `decision_kind` stays null.

### 5.3 W3 — timestamps & dedupe normalization

- Normalize `meta.timestamp` (unix seconds) → ISO-8601 UTC strings at the
  adapter boundary so dedupe keys, attribution ordering, and `### <timestamp>`
  export headings are backend-uniform. Missing → `""` (already tolerated).
- **No pseudo-timestamps** (review verdict; supersedes §11 commit-3 and
  §11.A.3): fabricated timestamps would (a) *defeat* dedupe for `/chat load`
  and rewind copies (the copy's `created_at`/mtime differs → different key for
  identical content), (b) fabricate export headings and manifest
  `first_ts`/`last_ts` provenance, (c) distort attribution ordering. Instead,
  timestamp-less prompts keep `""` exactly like upstream. If same-text
  timestamp-less prompts across kiro sessions ever false-drop in practice, the
  sanctioned fix is a **session-scoped key for empty timestamps** in shared
  dedupe (`ts === "" → sessionId\0ordinal\0text`) — a one-line, cross-backend
  change; not fabricated time.
- Session attribution order: earliest *real* message timestamp; sessions with
  none sort first and own no keys (existing upstream semantics — harmless).
- Second-resolution keys: a genuine same-second duplicate re-send would be
  swallowed as a fork copy — accepted; document in the fidelity notes.

### 5.4 W4 — kiro runner (S4) — the largest change

Invocation: `kiro-cli chat --no-interactive --agent <distill-agent> [--model m]`.

1. **Prompt delivery — RESOLVED: stdin.** Verified working to 150 KB
   (needle-checked). Same delivery path as the claude runner: write prompt to
   child stdin, close. argv is still ruled out for large prompts
   (`MAX_ARG_STRLEN` ≈ 128 KiB/arg). For prompts approaching the 400k-char
   budget, re-verify once during P2 with one budget-sized call; the
   file-resource agent fallback (below) stays documented as plan-B only:
   write prompt to `<home>/runner/prompt-<n>.md`, generate a per-call agent
   with `resources: ["file://<abs path>"]`, INPUT = short pointer instruction.
2. **Output parsing.** Strip ANSI (`/\x1b\[[0-9;?]*[a-zA-Z]/g`), strip the
   leading `> ` glyph, trim; then the existing fence-strip → `JSON.parse` →
   zod validate → one corrective retry. No JSON envelope exists.
   **Empty stdout with exit 0 is a real, observed transient-failure signature**
   ("Kiro is having trouble responding" on stderr) — classify as retryable,
   add bounded retry-with-backoff (e.g. 2 attempts, 2s/8s) *before* the
   corrective-retry layer; stderr snippet rides in the error for reporting.
3. **Schema enforcement.** No `--json-schema`: always take the existing
   "no jsonSchema capability" path (schema embedded in prompt + zod). The
   capability probe reduces to binary discovery + `--help` sanity.
4. **Tool disabling — RESOLVED.** Write the distill agent into the per-run
   scratch cwd's *local* agents dir
   (`<home>/runner-scratch/<generation>/.kiro/agents/cc-hindsight-distill.json`
   — local agent discovery is cwd-based, so the config must live under the
   actual spawn cwd): `{"tools": [], "mcpServers": {},
   "prompt": "<distill framing>"}`. Verified: local cwd discovery works with
   `--agent`, model reports no tools, no MCP startup. Bonus: nothing is
   written to the user's global `~/.kiro/agents/` at all.
5. **Session-store feedback loop — mechanics VERIFIED, safety invariant
   mandatory.** Every runner call (including failed ones) persists a session
   keyed to the spawn cwd. **One cwd design** (resolving an earlier
   contradiction): a single per-*run* scratch dir
   `<home>/runner-scratch/<generation>/` created at distill start — not
   mkdtemp-per-call, and temp-dir deletion is NOT store cleanup (the store is
   flat under `~/.kiro/sessions/cli/`). Guards:
   - all runner spawns use that scratch cwd (unique per run ⇒ per-cwd listing
     isolation, no cross-run races; safe under `--concurrency 3` because
     cleanup happens once, after all workers join);
   - sentinel first line in every distill prompt; K13 rejects it at
     extraction (echo-into-output is benign: it fails JSON parse → corrective
     retry; pin with a negative fixture);
   - post-run cleanup with a **hard scope filter — the deletion-safety
     invariant**: parse `--list-sessions --format json` (executed from the
     scratch cwd), and delete **only** sessions from the group whose
     `cwd === <the exact scratch dir>`; never delete from any other group even
     if the listing returns multiple cwd groups. Belt-and-braces: also require
     the session title to start with the sentinel. Pinned by a mocked test
     (`cleanup-scope` fixture) asserting sessions from other cwds survive.
   Cleanup is best-effort (failures logged, never fail the run) — K13 still
   protects the corpus if deletion misses.
6. **Context pollution.** Custom agents inherit steering/AGENTS.md by default;
   `chat.disableInheritingDefaultResources` is a *global* setting (do not flip
   silently). v1: accept + keep the "answer only from the content provided"
   instruction; document. Running from the scratch cwd avoids *workspace*
   steering; global steering still leaks in (bounded, user's own content).
7. **Timeouts/errors.** Keep 5-min SIGTERM→SIGKILL. Map: binary missing →
   `missing-binary` with kiro install hint; non-zero exit → `cli-error` with
   stderr snippet; parse/validation → retryable (one corrective retry).
8. **Cost line.** kiro prints `Credits: <n>` on stderr — parse best-effort and
   surface a per-run credits total in the distill summary (nice-to-have).
9. **Model pass-through.** `--model` forwarded verbatim; optional pre-flight
   validation against `--list-models --format json`.

### 5.5 W5 — prompt copy (digest/cluster/author/consolidate)

- Parameterize source naming: "Claude Code session" → "Kiro CLI session"
  (or neutral "coding-agent session" for merged corpora).
- Legend lines: keep `[decision]`/`[command]`/`[image pasted]` explanations
  only for sources that can produce them (claude); kiro sources omit them.
- Bump `DIGEST/CLUSTER/AUTHOR_PROMPT_VERSION`; the existing stale-checkpoint
  warnings handle mixed-version resumes.

### 5.6 W6 — preferences output target (S5)

- New flag `preferences --target claude|kiro|agents` (default: auto by source).
  - `claude`: today's CLAUDE.md block (unchanged).
  - `kiro`: steering-file block for `~/.kiro/steering/hindsight-preferences.md`
    (global) or `.kiro/steering/` (workspace) — same content, kiro-appropriate
    header comment and paste instructions.
  - `agents`: AGENTS.md block (kiro auto-inherits AGENTS.md; portable across
    other agent CLIs too).
- Optional stretch: `--write` to place the file directly (consent-prompted,
  never silently).

### 5.7 W7 — consent & cost copy

- Wording: "distill will invoke your local `kiro-cli` (your Kiro credits)".
- Mechanics unchanged: exact counts, `--dry-run`, `--yes`, decline = exit 2.
- Budget disclosure unchanged (400k-char default still comfortably inside the
  1M-token kiro model windows).

### 5.8 W8 — flags, env, branding

| Today | Ported |
|---|---|
| `--claude-dir` / `CLAUDE_CONFIG_DIR` | kept; plus `--kiro-dir` / `KIRO_CONFIG_DIR` (root `~/.kiro`) |
| — | `--source claude\|kiro\|auto` (default `auto`) |
| `--home` / `CC_HINDSIGHT_HOME` | unchanged |
| `claude` install hint | per-runner hint (`npm i -g @anthropic-ai/claude-code` vs kiro-cli install docs) |
| README "How it works" | dual-source diagram; kiro quickstart |

Naming: keep `cc-hindsight` + `--source` for v1 (npm continuity); revisit a
neutral name (e.g. `agent-hindsight`) only after parity ships.

### 5.9 W9 — tests & fixtures

- `test/fixtures/kiro/` per K-rule (see W2 table) + `kiro-home/` integration
  fixture mirroring `claude-home/` (metadata companions included).
- Runner tests: mocked spawn emitting ANSI-decorated stdout, credits stderr,
  non-zero exits, timeout path.
- Refactor-safety: existing Claude fixtures must stay byte-green (the seam
  refactor of `buildCorpus`/`buildAnaphora`/`buildOutcome` is the risk point).
- Real-data validation on this machine: 267 sessions / 27 interactive (+5
  orphan `.history`); assert automation sessions excluded with reasons,
  `--verbose` drop ledger sane, export idempotent (run twice, byte-compare).

---

## 6. Open items (verification queue)

| # | Question | Why it matters | How to resolve | Status |
|---|----------|----------------|----------------|--------|
| OPEN-1 | stdin prompt delivery, incl. large | Runner design | Probed: small, multi-line, 8 KB, 96 KB, 150 KB all delivered (needle echoed); argv capped ~128 KiB | **RESOLVED: stdin** (re-verify one 400k-char call in P2) |
| OPEN-2 | `tools: []` suppression + local agent discovery | Tool-free distill calls | Probed: scratch-cwd local agent, `TOOLS=NONE` response | **RESOLVED: yes, both** |
| OPEN-3 | Runner-created session cleanup | Feedback-loop guard | Probed: failed runs persist too; list→delete→empty verified | **RESOLVED** (cleanup per distill run) |
| OPEN-4 | Can kiro Prompts carry non-text blocks (images)? | R11 mapping | Census: **0/410 Prompts** have non-text blocks; 1 image exists inside a toolResult (machine side, skipped). Tolerant placeholder path kept for drift | **RESOLVED: no** (tolerant path stays) |
| OPEN-5 | Exit codes of headless failures (bad model, auth expired) | Error mapping fidelity | Partially known: transient backend errors exit **0** with empty stdout — the runner keys on output, not exit code. Bad-model/auth probes cheap during P2 | pending (non-blocking) |
| OPEN-6 | v1 sqlite store importer | Scope guard | Ship v2-only; document; revisit on demand | deferred |

## 7. Phasing & effort

| Phase | Contents | Effort | Exit criteria |
|---|---|---|---|
| P1 — read side | Seam refactor (`buildCorpus`/`buildAnaphora`/`buildOutcome` signatures), `sources/kiro` discover+extract+timeline, K-fixtures, `--source`/`--kiro-dir` flags | ~2–3 days | `scan`/`export` on kiro data; all Claude fixtures byte-green; real-data validation on this machine |
| P2 — runner | `runners/kiro.ts` + empty-stdout backoff, distill agent bootstrap, feedback-loop guards w/ deletion-safety invariant, consent copy, 400k-char stdin re-verification + OPEN-5 probes | ~2 days | `distill --dry-run` + one real consented smoke distill on kiro sessions |
| P3 — outputs & polish | preferences `--target` + consolidate-runner threading, prompt copy per source, §12.1 copy surfaces, README/docs, install hints | ~1 day | `preferences --target kiro` renders steering block |
| P4 — hardening | Real-data edge sweep (267 sessions), `--verbose` ledger audit, idempotency byte-compare, cost-line surfacing | ~1 day | Zero unexplained drops on the reference corpus |

Total: **~1 focused week**; P1 alone already ships useful kiro exports.

## 8. Upstream PR strategy

The end goal is upstreaming to `adityaarunsinghal/cc-hindsight`. All work is
staged **locally first**: full clone in the workspace, branch
`feat/kiro-cli-backend`; nothing is pushed and no PR is opened until the full
gate passes and real-data validation is done (explicit go-ahead).

**Delivery is split** (review verdict: a single ~3k-LoC 7-commit PR to a solo
maintainer over-taxes review and risks wholesale rejection):

0. **Pre-PR issue** first — propose the multi-backend seam, link this plan's
   evidence (store census, probe results), ask about naming (`--source`,
   `origin`) and the roadmap fit ("Agent SDK orchestration" / plugin
   packaging suggest the author already wants pluggable backends). Cheap
   alignment before code review.
1. **PR-1 (refactor-only)** = commit 1: SessionSource + AgentRunner seams
   behind shims, zero behavior change, fixtures byte-green. Small, safe,
   reviewable on its own.
2. **PR-2 (read side)** = commits 2–3: kiro discovery + extractor + fixtures;
   ships `scan`/`export` for kiro users.
3. **PR-3 (runner + outputs)** = commits 4–6 (+docs commit 7): kiro runner,
   distill wiring, preferences targets.

Constraints from CONTRIBUTING.md that every PR must honor:
- **Zero new runtime deps** (`stripVTControlCharacters`, `mkdtemp` are node
  builtins; tree stays `citty`/`zod`/`@clack/prompts`).
- **Tests never read `~/.kiro`** (extend the "never read `~/.claude`" rule);
  synthetic fixtures only, spawn always mocked.
- **No LLM calls outside distill/consolidate**, always consent-gated.
- Conventional commits; prompt-version bumps ride with their prompt changes
  and contract-test updates.
- **Maintainer-testability caveat for PR-3**: kiro-cli is publicly
  installable but auth-gated and auto-updating — the author may be unable to
  run it. Mitigate: exhaustive mocked-spawn tests, a `docs/kiro-backend.md`
  with the probe evidence (this plan §3.5), and offering ourselves as the
  maintainer-of-record for the kiro runner path.

Gate before any push: `npm run lint && npm run typecheck && npm test &&
npm run build && npm pack --dry-run` + `check-pack` (the exact CI/prepublish
sequence) plus the P4 real-data checklist.

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Store feedback loop (distill runs pollute `~/.kiro/sessions/cli`, later exports ingest them) | High (silent corpus corruption) | Triple guard: scratch-cwd isolation + sentinel header + K13 self-recognition + post-run delete (W4.5) — all mechanics verified |
| Transient backend failures with exit 0 + empty stdout (observed in a burst, then identical calls succeeded) | High (distill stage failures mid-run) | Runner keys on output not exit code; bounded retry-with-backoff below the corrective retry; checkpoint-per-unit already limits blast radius |
| Prompt delivery cap (argv 128 KiB) | ~~High~~ resolved | stdin delivery verified to 150 KB; file-resource agent fallback documented as plan-B; one budget-sized (400k) re-verification in P2 |
| Human/automation misclassification (no reliable `isSidechain` equivalent) | Medium (junk oneshots or lost sessions) | Recall-oriented default + observable per-session classification reasons under `--verbose`; signals: `.history`, `parent_session_id`, `[AGENT SYSTEM PROMPT]` |
| Steering/context leaks into distill calls (custom agents inherit global steering) | Medium (non-determinism, bias) | Scratch cwd kills workspace steering; documented residual global-steering caveat; "answer only from provided content" instruction |
| kiro format drift (`version: "v1"` envelope may evolve) | Medium | Version-tolerant parsing + fixture drill (same discipline as Claude drift); log unknown `kind`s as counted skips |
| Seam refactor regressions in Claude path | Medium | Commit 1 is refactor-only with byte-green fixture requirement before any kiro code lands |
| ANSI/UI output format changes across kiro versions | Low | Strip-then-parse is tolerant; envelope-free parsing keys only on JSON extractability; retry once |
| Second-resolution timestamps weaken dedupe keys | Low | Documented; collision requires identical text in same second |

## 10. Appendix — format mapping quick reference

### A. Claude Code entry → kiro-cli entry

| Claude Code | kiro-cli |
|---|---|
| `{type:"user", message:{content}}` | `{kind:"Prompt", data:{content:[{kind:"text",data}], meta:{timestamp}}}` |
| `{type:"assistant", message:{content:[text\|tool_use]}}` | `{kind:"AssistantMessage", data:{content:[{kind:text\|toolUse\|thinking}]}}` |
| `tool_result` block inside user entry | `{kind:"ToolResults", data:{content:[{kind:"toolResult", data:{status, content:[{kind:text\|json}]}}]}}` |
| `{type:"attachment", attachment:{queued_command}}` | (none observed) |
| `isSidechain` / nested subagent dirs | `parent_session_id` in companion metadata; flat dir |
| `isCompactSummary` entries | `{kind:"Compaction"}` (+ `messages_snapshot` duplicate hazard) |
| `<command-name>` XML in content | (client-side only; `.history` file) |
| `[Request interrupted by user]` user entry | `"Tool use was cancelled by the user"` toolResult text |
| ISO-8601 `timestamp` per entry | unix-seconds `meta.timestamp` on Prompts only |
| dash-encoded project dir | `cwd` field in `<uuid>.json` (lossless) |
| session id = file stem (uuid) | same |

### B. Runner surface

| Concern | `claude` | `kiro-cli` |
|---|---|---|
| Headless flag | `-p` | `chat --no-interactive` |
| Structured output | `--output-format json` envelope | none — raw ANSI-decorated text on stdout |
| Server-side schema | `--json-schema` (draft-7) | none — prompt-embedded schema + zod only |
| Disable tools | `--tools ""` | local agent config `"tools": []` (verified: TOOLS=NONE) |
| Model | `--model` | `--model` (ids from `--list-models --format json`) |
| Prompt delivery | stdin | stdin (verified to 150 KB, needle-checked) |
| Cost visibility | envelope `total_cost_usd` | stderr `Credits: <n>` line |
| Session side effects | none | auto-saves a session per call, even on failure (guarded + cleaned) |
| Failure signature | non-zero exit / `is_error` envelope | **exit 0 + empty stdout** + stderr message → retry on empty output |

---

## 11. Refactor specification (commit-by-commit)

> Produced by an opus subagent from read-only analysis of /tmp/cc-hindsight;
> spot-verified against source (ManifestEntry.source collision, test import
> lines confirmed). Integrator annotations follow in §11.A.

### 0. The seam in one paragraph

`ExtractedMessage`, `Drop`, `ExtractResult`, and `TimelineEvent` (all currently defined in `src/core/extract.ts`) become the shared currency, hosted in `src/sources/types.ts`. A `SessionSource` produces them; everything downstream (`dedupe`, `anaphora`, `outcome`, `render`, `distill`) consumes only them and never parses raw lines again:

```ts
// src/sources/types.ts (new)
export type SourceName = "claude" | "kiro";
export interface SessionSource {
  readonly name: SourceName;
  /** Enumerate projects+sessions in this backend's store; missing store → []. */
  discover(opts?: { countEntries?: boolean }): ProjectInfo[];       // ProjectInfo/SessionInfo move here from core/discover.ts
  /** Fidelity contract: raw lines → human messages + observable drops. */
  extract(lines: string[]): ExtractResult;
  /** Full-conversation timeline for anaphora/outcome context. */
  timeline(lines: string[]): TimelineEvent[];
  /** Optional session-level classification from store metadata (kiro: interactive vs automation). */
  classify?(session: SessionInfo & { project: string }): "interactive" | "automation" | undefined;
}
```

The interface carries forward, as a documented law, the guarantee currently stated on `humanEntryText` in `extract.ts`:

> "Extracted so {@link extractMessages} and {@link extractTimeline} produce byte-identical human-message text — the dedupe key and the anaphora↔export index alignment both depend on the two paths agreeing exactly."

New wording: *every message in `extract(lines).messages` must appear as a `human` `TimelineEvent` from `timeline(lines)` with identical `(timestamp, text)`, in file order.* Claude satisfies it by sharing `humanEntryText`; the kiro extractor must satisfy it the same way (one shared per-entry text function).

---

### 1. Exact signatures that change

**`buildCorpus` / `DedupeInput`** — current (`src/core/dedupe.ts`):

```ts
import { type Drop, type ExtractedMessage, extractMessages } from "./extract.js";

export interface DedupeInput {
  project: string;
  sessionId: string;
  sourcePath: string;
  /** Raw newline-delimited JSONL lines of the session file. */
  lines: string[];
}
export function buildCorpus(input: DedupeInput[]): Corpus
```

`buildCorpus` currently extracts itself: `const result = extractMessages(session.lines);`. New — dedupe goes post-extraction and drops its only claude import:

```ts
import type { Drop, ExtractedMessage, ExtractResult } from "../sources/types.js";

export interface DedupeInput {
  project: string;
  sessionId: string;
  sourcePath: string;
  /** Pre-extracted result from SessionSource.extract(lines). */
  extracted: ExtractResult;   // { messages, drops, badLines }
}
export function buildCorpus(input: DedupeInput[]): Corpus   // signature otherwise unchanged
```

Body diff is one line: `const extracted = input.map((session) => ({ session, result: session.extracted, earliest: earliestTimestamp(session.extracted.messages) }));`. Index alignment is preserved because nothing after extraction changes: the attribution sort (earliest ts, then `sessionId`), the `seen` set, and `index: messages.length` per-session survivor numbering are untouched — given `extracted === extractMessages(lines)`, the corpus is byte-identical, which the export fixtures assert. The alignment *between* corpus indices and anaphora records now rests on the SessionSource law above instead of on both functions living in one file.

**`buildAnaphora`** — current (`src/core/anaphora.ts`, which imports `extractTimeline` via `import { extractTimeline, type TimelineEvent } from "./extract.js";`):

```ts
export function buildAnaphora(session: CorpusSession, lines: string[]): AnaphoraRecord[]
```

New — caller supplies the timeline; the module keeps zero claude knowledge:

```ts
export function buildAnaphora(session: CorpusSession, timeline: TimelineEvent[]): AnaphoraRecord[]
```

(First body line `const timeline = extractTimeline(lines);` is deleted; the rest is unchanged.)

**`buildOutcome`** — current (`src/core/outcome.ts`, imports `import { extractTimeline } from "./extract.js";`):

```ts
export function buildOutcome(session: CorpusSession, lines: string[]): OutcomeEvidence
```

New: `buildOutcome(session: CorpusSession, timeline: TimelineEvent[]): OutcomeEvidence` — `final_human_turns` still comes from `session.messages.slice(-FINAL_TURNS)`, the tail walk runs over the passed timeline.

**`runExport` internals** (`src/commands/export.ts`). Signature `export function runExport(opts: ExportArgs): ExportStats` is kept; internals change at four points:

```ts
// today:
const projects = discoverProjects(claudeDir, { countEntries: false });
...
inputs.push({ project: project.shortName, sessionId: ..., sourcePath: session.path, lines: content.split(/\r?\n/) });
...
const corpus = buildCorpus(inputs);
const linesBySource = new Map<string, string[]>();
...
const records = buildAnaphora(session, lines);
const outcome = buildOutcome(session, lines);
```

becomes:

```ts
const sources = resolveSources(opts.source, { claudeDir, kiroDir });   // src/sources/registry.ts
const timelineOf = new Map<string, () => TimelineEvent[]>();           // sourcePath → lazy timeline via OWNING source
for (const src of sources)
  for (const project of src.discover({ countEntries: false }))
    for (const session of project.sessions) {
      const lines = readLines(session.path);                            // same tolerated fs.readFileSync
      if (src.classify?.({ ...session, project: project.shortName }) === "automation") { stats.automationSkipped++; continue; }
      inputs.push({ project: project.shortName, sessionId: stem, sourcePath: session.path,
                    extracted: src.extract(lines) });
      timelineOf.set(session.path, () => src.timeline(lines));
      originOf.set(session.path, src.name);
    }
const corpus = buildCorpus(inputs);       // ONE union pass — cross-source dedupe is a no-op in practice
...
const timeline = timelineOf.get(session.sourcePath)?.() ?? [];
const records = buildAnaphora(session, timeline);
const outcome = buildOutcome(session, timeline);
```

`ManifestEntry` gains a backend field — **not** named `source`, because that name is taken by the source *path* today:

```ts
export interface ManifestEntry {
  export: string;
  source: string;      // ← already the sourcePath ("source: session.sourcePath") — unchanged
  origin?: "claude" | "kiro";   // NEW; absent ⇒ "claude" (old-manifest rule)
  project: string; sessionId: string; messages: number; first_ts: string; last_ts: string;
}
```

**Distill + status touchpoints.** `computePlan(entries, inputs)` and its math (`authorEstimate = Math.max(1, Math.round(digests / 3))`) are untouched; filtering happens at the manifest-read site in `runDistill`: `entries = entries.filter(e => activeOrigins.has(e.origin ?? "claude"))`. `DistillArgs` gains `source?: string; "kiro-dir"?: string; runner?: string`, forwarded into the no-manifest auto-export offer (`runExport({ home, "claude-dir", project, source, "kiro-dir", output })`). In `src/distill/pipeline.ts` only the type import moves: `import { type RunClaudeOptions, runClaude } from "../claude/runner.js";` → `from "../runners/claude.js"` (types from `../runners/types.js`); `const runner: RunnerFn = opts.runner ?? runClaude;` stays claude-by-default. Status: `export function renderStatus(opts: { home: string; claudeDir: string }): string` → `renderStatus(opts: { home: string; claudeDir: string; kiroDir?: string; source?: SourceMode })` — optional params, so `test/library.test.ts`'s call sites compile unchanged. Also `resolvePaths(args: { home?: string; "claude-dir"?: string })` → adds `"kiro-dir"?: string`, `ResolvedPaths` gains `kiroDir` (default `KIRO_CONFIG_DIR` env, else `~/.kiro`), and `sharedArgs` gains `source` + `kiro-dir`.

---

### 2. File moves, new files, shims, and the tests they protect

Moves (git `mv` + shim at old path):

| From | To | Shim content |
|---|---|---|
| `src/core/extract.ts` | `src/sources/claude/extract.ts` (types split into `src/sources/types.ts`) | `src/core/extract.ts` → `export * from "../sources/claude/extract.js"; export * from "../sources/types.js";` |
| `src/core/discover.ts` | `src/sources/claude/discover.ts` | `src/core/discover.ts` → `export * from "../sources/claude/discover.js";` |
| `src/claude/runner.ts` | split: `src/runners/shared.ts` (IO, spawn, errors, retry) + `src/runners/claude.ts` (envelope, args, probe) | `src/claude/runner.ts` → `export * from "../runners/shared.js"; export * from "../runners/claude.js";` (incl. `export { AgentRunnerError as ClaudeRunnerError }` — a *class alias*, so `instanceof` in tests keeps working) |

New files: `src/sources/types.ts`, `src/sources/registry.ts` (`resolveSources`), `src/sources/claude/index.ts` (`claudeSource(claudeDir): SessionSource`), `src/sources/kiro/{discover,extract,index}.ts`, `src/runners/types.ts` (`AgentRunner`, `AgentRunOptions` — alias of today's `RunClaudeOptions`), `src/runners/kiro.ts`, `src/runners/registry.ts` (`resolveRunner`).

Test files that break **without** the shims — exact import lines found:

- `test/extract.test.ts:3` — `import { extractMessages } from "../src/core/extract.js";`
- `test/discover.test.ts:5` — `import { decodeProjectDir, discoverProjects, type ProjectInfo } from "../src/core/discover.js";`
- `test/runner.test.ts:1–11` — `import { type Capabilities, ClaudeRunnerError, defaultIo, probeCapabilities, type RunnerIo, resetCapabilityCache, runClaude, type SpawnResult } from "../src/claude/runner.js";`
- `test/author.test.ts:7` — `import type { RunClaudeOptions } from "../src/claude/runner.js";`
- `test/cluster.test.ts:7` — `import type { RunClaudeOptions } from "../src/claude/runner.js";`
- `test/pipeline.test.ts:7` — `import type { RunClaudeOptions } from "../src/claude/runner.js";`
- `test/preferences.test.ts:6` — `import type { RunClaudeOptions } from "../src/claude/runner.js";`

Tests that break on **signature** (not path) and get small call-site edits in commit 1 (no shim can hide a changed parameter):

- `test/dedupe.test.ts:2` — `import { buildCorpus, type DedupeInput } from "../src/core/dedupe.js";` (its input builders add `extracted: extractMessages(lines)`)
- `test/anaphora.test.ts:10–11` — `import { buildCorpus, type CorpusSession, type DedupeInput } from "../src/core/dedupe.js";` / `import { renderExport } from "../src/core/render.js";` (calls become `buildAnaphora(session, extractTimeline(lines))`)
- `test/outcome.test.ts:2–3` — `import { buildCorpus, type CorpusSession } from "../src/core/dedupe.js";` / `import { buildOutcome, FINAL_TURNS, OUTCOME_NOTE, TAIL_CHARS } from "../src/core/outcome.js";`

---

### 3. `--source auto` threading

- **Flag surface**: `sharedArgs` gains `source: { type: "string", default: "auto" }` (`claude|kiro|auto`) and `"kiro-dir"`. `resolveSources("auto")` returns each backend whose store exists and discovers ≥1 project, in fixed order claude-then-kiro; explicit `claude`/`kiro` returns exactly one; unknown value → error exit 1.
- **manifest.json backward compat**: new optional `origin` field (see §1; `source` is already the path). Readers everywhere use `e.origin ?? "claude"` — an old manifest written before this change is therefore all-claude, which is factually correct. Writers always emit `origin`. Precedent for scope: manifest is already rewritten wholesale from the current run's eligible set (a `--project` run narrows it today), so a `--source claude` run narrowing the manifest is existing behavior, documented.
- **Export stats lines**: today's byte-pinned line
  `exported ${stats.exportedSessions} sessions (${stats.totalMessages} messages, ${stats.duplicatesDropped} duplicates dropped) → ${stats.exportsDir}`
  stays byte-identical when exactly one source is active (keeps `test/export.test.ts` green); with two active sources the session count gains a breakdown: `exported 12 sessions (9 claude + 3 kiro; 260 messages, …)`. `ExportStats` gains additive fields `sessionsByOrigin: Partial<Record<SourceName, number>>` and `automationSkipped: number` (additive struct fields don't break existing assertions).
- **Status funnel over two stores**: the current computation
  ```ts
  discovered = discoverProjects(opts.claudeDir, { countEntries: false }).reduce((n, p) => n + p.sessions.length, 0);
  ```
  becomes a sum over `resolveSources`; the `discovered N session(s)` line is unchanged when only the claude store exists, and gains ` (Y claude, Z kiro)` when both do. The digested/clustered/authored sections key on export filenames and generations and need no change; the stale-digest check (`manifestExports.has(k)`) is origin-agnostic and stays.
- **Distill plan math**: unchanged (`computePlan` untouched); origin filtering happens before it. The resume-note intersection in `computeResumeNote` already intersects checkpoint keys with the eligible set, so origin-filtered runs report honestly for free.
- **Export-name collisions across sources**: `exportFileName(project, sessionId, used)` already resolves collisions by lengthening the id prefix, then a numeric suffix ("On collision the id prefix is lengthened one character at a time until unique"). The one shared `used` set now spans both sources; determinism holds because corpus order (earliest ts, then `sessionId`) is a total order over the union. Kiro session ids need not be UUIDs — `exportFileName` already covers that ("a non-uuid basename simply contributes its first 8 characters of stem"). Same-short-name projects across stores coexist; `manifest.origin` + the `source` path disambiguate.
- **Prune rule**: today `if (!opts.project && minMessages === 1)` prunes any `.md` not in the current write set. A `--source claude` run must not delete kiro exports, so the guard gains `&& sourceMode === "auto"` — symmetric with the existing `--project` reasoning ("otherwise the current write set is a deliberate subset").

---

### 4. `AgentRunner` extraction from `src/claude/runner.ts`

**Stays claude-specific** (`src/runners/claude.ts`):
- Envelope parsing: `ClaudeEnvelope`, `extractResult(result: SpawnResult)` including the `is_error` branch and "claude envelope missing a 'result' field".
- Arg building: `buildArgs` — `["-p", "--output-format", "json"]`, `args.push("--json-schema", JSON.stringify(toJsonSchema(opts.schema)))`, `args.push("--tools", "")`, `--model`.
- Capability probe: `Capabilities`, `probeCapabilities` (`--help` scan for `--json-schema` / `--tools` / `--disallowedTools`), `capabilitiesCache`, `resetCapabilityCache`, `CLAUDE_INSTALL_HINT`.

**Moves to shared** (`src/runners/shared.ts`):
- `SpawnResult`, `SpawnOptions` (gains optional `cwd?: string`, default absent — zero behavior change), `RunnerIo`, `defaultIo` (`defaultWhich`, `defaultSpawn` with the SIGTERM→SIGKILL grace and the stdin-EPIPE swallow), `KILL_GRACE_MS`, `DEFAULT_TIMEOUT_MS`.
- Error machinery: `AgentRunnerError` (today's `ClaudeRunnerError`, same kinds `missing-binary | timeout | cli-error | validation`), `RetryableError`, `snippet`, `stripFence`.
- **Schema-embedding fallback**: the `if (!caps.jsonSchema)` branch of `buildPrompt` (`Respond ONLY with JSON matching this schema:\n${json}`) becomes `embedSchema(prompt, schema)` — claude uses it when the probe says no `--json-schema`; kiro uses it *always* (no envelope, no server-side schema).
- **Zod validation + corrective retry**: the `for (let attempt = 0; attempt < 2; attempt++)` loop with the corrective note (`Your previous response could not be used (${lastDetail}). Respond ONLY with valid JSON…`) becomes `runWithCorrectiveRetry(basePrompt, attemptFn)` parameterized by a per-backend "spawn + parse to raw JSON" step; `schema.parse(raw)` stays in the shared loop.

**Kiro runner** (`src/runners/kiro.ts`, commit 4):
- Spawn `kiro-cli chat --no-interactive --agent <no-tools-agent>` (constant `KIRO_NO_TOOLS_AGENT = "cc-hindsight-distill"`, an agent definition with no tools that the runner ensures exists before first use — mirrors claude's `--tools ""` intent); prompt on stdin via the shared `RunnerIo.spawn`.
- Parse step: `stripVTControlCharacters(stdout)` (node:util — builtin, zero new deps), trim, `stripFence`, `JSON.parse`. No envelope: exit ≠ 0 → `AgentRunnerError("cli-error", …, { stderr })`; unparseable non-empty stdout → `RetryableError` (feeds the shared corrective retry).
- **Empty-stdout-with-exit-0** = transient transport failure, retried with bounded backoff *inside* the kiro spawn step, i.e. **below** the shared corrective retry: `KIRO_EMPTY_RETRIES = 2` extra attempts with injectable delays (500 ms, 2 000 ms; `sleep` injected for tests), same input, **no corrective note** — the model produced nothing, so there is nothing to correct, and burning the single corrective retry on a transport blip would waste it. Exhausted → `AgentRunnerError("cli-error", "kiro-cli produced no output after 3 attempts")`. Worst case per stage call: 2 corrective × 3 transport = 6 spawns, all bounded.
- **Session-store cleanup**: `kiro-cli chat` persists the conversation in its local store keyed by working directory; each run spawns in a fresh `mkdtemp` cwd (`SpawnOptions.cwd`) and the runner best-effort deletes that temp dir afterward (`try/catch`, never affects the result), so distill runs don't accumulate resumable sessions against real project paths. Asserted in tests via mocked IO (cleanup invoked after success *and* after failure).
- `src/runners/registry.ts`: `resolveRunner(mode: "claude" | "kiro" | "auto", io): AgentRunner` — explicit modes require that binary (typed `missing-binary` error with per-backend install hint); `auto` prefers claude, falls back to kiro via `io.which`. Distill/preferences gain `--runner` (default `claude` to preserve behavior); note: this flag is beyond the two mandated ones, but without a selection mechanism the kiro runner is unreachable — source (where transcripts live) and runner (which CLI distills) are deliberately orthogonal.

---

### 5. Seven conventional commits

| # | Commit | Files touched | Tests | Invariant |
|---|---|---|---|---|
| 1 | `refactor(core): extract SessionSource and AgentRunner seams behind shims` | new `src/sources/{types,registry}.ts`, `src/sources/claude/{discover,extract,index}.ts` (moves), shims `src/core/{extract,discover}.ts`; split `src/claude/runner.ts` → `src/runners/{types,shared,claude}.ts` + shim; edit `src/core/{dedupe,anaphora,outcome}.ts`, `src/commands/export.ts`, `src/distill/pipeline.ts` (import paths only) | update call sites in `test/{dedupe,anaphora,outcome}.test.ts`; all 17 other test files untouched (shims) | **Zero behavior change**: full suite green, export fixture output byte-identical (`test/export.test.ts` idempotency + content assertions), `manifest.json` bytes unchanged, no new flags |
| 2 | `feat(kiro): discover kiro-cli session stores (--source, --kiro-dir)` | `src/sources/kiro/{discover,index}.ts`, `src/sources/registry.ts`, `src/commands/_shared.ts` (`sharedArgs`, `resolvePaths`), `src/commands/scan.ts`, `src/commands/status.ts` (discovered line) | new `test/kiro-discover.test.ts` + `test/fixtures/kiro-home/`; extend `test/scan.test.ts` | claude-only machines: `scan`/`status` output byte-identical; missing kiro dir never errors (mirrors `discoverProjects`'s "missing … yields an empty array (never throws)") |
| 3 | `feat(kiro): extract kiro transcripts into the shared corpus` | `src/sources/kiro/extract.ts` (extract + timeline + classify), `src/commands/export.ts` (multi-source loop, `origin` in manifest, stats breakdown, prune guard) | new `test/kiro-extract.test.ts` + `test/fixtures/kiro-extract/*.json(l)`; extend `test/export.test.ts` with a dual-store fixture home | exported claude `.md` bytes unchanged; SessionSource law holds for kiro (extract↔timeline agreement test); kiro messages without native timestamps get stable pseudo-timestamps (file mtime + ordinal) so the `(timestamp, text)` dedupe key can't false-drop identical prompts across kiro sessions |
| 4 | `feat(kiro): add kiro-cli agent runner with empty-stdout backoff` | `src/runners/kiro.ts`, `src/runners/registry.ts`, `src/runners/shared.ts` (`cwd` option) | new `test/kiro-runner.test.ts` (mocked `RunnerIo` per CONTRIBUTING "Unit tests mock the spawn layer"): ANSI+fenced happy path, empty-stdout×2-then-success with injected sleep, exhaustion error, corrective retry on bad JSON, cleanup-after-run, exit≠0 | no real spawn in tests; retry ceilings bounded (≤6 spawns); `test/runner.test.ts` (claude) untouched and green |
| 5 | `feat(distill): thread --source and runner selection through plan and status` | `src/commands/distill.ts` (args, origin filter, `resolveRunner`, forward flags to auto-export), `src/commands/status.ts` (kiroDir param, funnel), `src/claude/consent.ts` (copy only if runner ≠ claude) | extend `test/consent.test.ts` (mixed-origin manifest filtering; old manifest without `origin` treated as claude), `test/library.test.ts` (renderStatus with kiroDir) | plan math byte-identical for claude-only manifests; consent block copy unchanged under default runner; checkpoint/resume semantics untouched |
| 6 | `feat(preferences): render --target claude, kiro, or agents blocks` | `src/core/preferences.ts` (`renderPreferencesBlock(prefs, taskCount, target, now)`; `renderClaudeMdBlock` kept as deprecated wrapper), `src/commands/preferences.ts` (`--target` arg, footer hints per target) | extend `test/preferences.test.ts`: default output byte-identical; kiro target emits a `~/.kiro/steering/*.md`-ready block; agents target emits an AGENTS.md section | `--target claude` (default) bytes = today's `renderClaudeMdBlock` output exactly |
| 7 | `docs: document multi-backend seams, kiro fixtures, and new flags` | `README.md`, `CONTRIBUTING.md` (extend the fixture drill to `test/fixtures/kiro-extract/`, document the SessionSource law and the runner retry layering), `CHANGELOG.md` | none (CI docs pass) | `npm test && npm run lint && npm run typecheck && npm run build` green; `scripts/check-pack.mjs` file list unchanged except dist |

All constraints hold: zero new runtime deps (`stripVTControlCharacters`, `mkdtemp` are node builtins; the tree stays `citty`/`zod`/`@clack/prompts`), tests only on synthetic fixtures under `test/fixtures/`, spawn always mocked, conventional commit prefixes throughout.

### 6. LoC estimates and risk

| Commit | New/changed LoC (excl. pure moves) | Moved LoC |
|---|---|---|
| 1 | ~420 (types 80, claude source wrapper 60, dedupe/anaphora/outcome 40, export 50, runner split glue 130, shims 15, test call sites 45) | ~1,100 |
| 2 | ~200 code + ~150 tests/fixtures | — |
| 3 | ~330 code + ~250 tests/fixtures | — |
| 4 | ~250 code + ~220 tests | — |
| 5 | ~140 code + ~150 tests | — |
| 6 | ~110 code + ~80 tests | — |
| 7 | ~200 docs | — |

**Riskiest change: commit 1's re-plumbing of `buildCorpus` → `buildAnaphora`/`buildOutcome`.** It rewires exactly the invariant the codebase calls sacred ("Index alignment is sacred: every record's `index` is the POST-DEDUPE message index from `buildCorpus` — the position of that message in the rendered export"). The failure mode is silent: if export ever pairs a session with a timeline produced from different lines (or a different source), every command still exits 0 and every file still writes — but `anaphora.json` records attach to the wrong messages and quietly corrupt the author stage's inputs, the same class of damage CONTRIBUTING flags for extract.ts ("a bug here silently corrupts everything downstream"). Mitigations that make it shippable: the guarantee is mechanically enforced by `test/anaphora.test.ts` (which cross-checks records against `renderExport` output) plus the byte-green export fixture assertion, and the lazy `timelineOf` map is keyed by `sourcePath` — the same unique key the current `linesBySource` map already uses — so the pairing cannot drift by construction. The kiro *extractor* (commit 3) carries external-format risk, but it is additive: it cannot corrupt the claude path, and format drift is handled by the existing fixture drill.

### 11.A Integrator annotations (reconciling §11 with verified probe facts)

1. **Temp-cwd deletion does NOT clean the session store** (§11.4 kiro runner
   bullet). Sessions persist as flat files under `~/.kiro/sessions/cli/`
   regardless of the spawn cwd — deleting the spawn directory removes
   nothing from the store (verified: failed probe runs left sessions behind).
   Correct cleanup = the verified recipe with the deletion-safety invariant
   (final design in §5.4 W4.5): one per-run scratch cwd
   `<home>/runner-scratch/<generation>/` (not mkdtemp-per-call), post-run
   `--list-sessions --format json` from that cwd, delete **only** the
   scratch-cwd group with sentinel-title match; K13 sentinel as
   defense-in-depth. Commit 4's test list changes accordingly: replace the
   "cleanup-after-run temp-dir removal" assertion with the `cleanup-scope`
   store-deletion test (§12.3).
2. **`ManifestEntry.origin` naming** — adopted; §5 W-items and §3 tables in
   this plan should read `origin` wherever "source field" was implied.
3. **Pseudo-timestamps for timestamp-less kiro prompts** (§11.5 commit 3:
   mtime + ordinal) — **SUPERSEDED in v1.0**: the adversarial review showed
   fabricated timestamps defeat dedupe for rewind/`/chat load` copies and
   pollute export headings + manifest provenance. Final verdict lives in §5.3:
   keep `""` (upstream parity); if false-drops ever materialize, use a
   session-scoped dedupe key for empty timestamps — never fabricated time.
   Commit 3's test list drops the pseudo-timestamp fixture accordingly.
4. **`--runner` flag** (§11.4 registry) — accepted as necessary beyond the two
   mandated flags; default `auto` (prefer the CLI that matches `--source`,
   fall back by availability) rather than hard-default `claude`, so a
   kiro-only machine works out of the box; still overridable.
5. **Consent copy** (§11.5 commit 5) must state *which* CLI will be invoked —
   the byte-pinned block becomes parameterized by runner id; consent tests
   pin both variants.

---

## 12. Adversarial-review integration (v1.0 deltas)

An opus reviewer audited v0.4 against the source. High-severity findings are
fixed inline above (K2 precedence rewrite in §5.2; pseudo-timestamps killed in
§5.3; deletion-safety invariant in §5.4 W4.5; split PR delivery in §8). The
remaining accepted findings, as actionable deltas:

### 12.1 Copy & threading gaps (assign to commits 5–6)

- **`preferences --consolidate` runner threading**: today it dynamically
  imports the claude runner and hardcodes "invoke your local `claude` CLI"
  copy. It must route through `resolveRunner` and parameterized consent copy —
  otherwise kiro-only machines break. Owner: commit 5 (add to its test list).
- **Five orphaned Claude-branded copy surfaces**, each needs per-source/runner
  copy + a test: `copy.ts` paste hint; `distill.ts` auto-export offer
  ("reads ~/.claude…"); `scan.ts` empty-store hint (kiro-only machines);
  `status.ts` "(claude dir not found)" + funnel copy; `pipeline.ts`
  provenance `model: "claude CLI default"` → runner-qualified default label.
- **Runner default contradiction resolved**: `--runner` defaults to `auto`
  (prefer the runner matching the active source, fall back by binary
  availability) — commit 5's "consent copy unchanged under default runner"
  invariant is restated as "unchanged when the resolved runner is claude".
- **Prompt copy + version bumps** (§5.5) get explicit commit ownership:
  commit 5.

### 12.2 Extraction semantics refinements (assign to commits 1, 3)

- **`Clear` is an anaphora boundary**: an antecedent must not cross a `/clear`
  (the model never saw pre-Clear text either). Add a `boundary` TimelineEvent
  kind in the shared types (commit 1, claude emits none) and teach
  `findAntecedent`/`findDecision` to stop at it (shared change, fixture for
  both backends). Kiro emits it for `Clear` and `Compaction` entries.
- **Compaction ignore gets observability** (n=1 evidence): if a
  `messages_snapshot` contains a user-role prompt whose `(timestamp, text)`
  never appears as a live `Prompt` entry in the same file, record a Drop
  (`K12: snapshot-only prompt`) so `/chat load`-imported pre-compaction
  history is *visible* if it ever occurs, rather than silently absent.
- **Orphan `.history` files** (5 in the census, no matching transcript):
  surface in `scan`/`status` as "N interactive session(s) whose transcript is
  gone" — cheap, keeps the census honest.
- **Slash-command fidelity note**: kiro loses R10-style `[command]` recovery
  by design (commands never reach the transcript). Document as a known
  fidelity-parity gap in README/docs, not a bug.

### 12.3 Test/fixture additions (fold into §5.9 W9)

- K2 companion-file triples: (jsonl + metadata + history) × {interactive,
  automation-first-prompt, hybrid rewind-with-history, parent-linked}.
- Boilerplate-first automation fixture (naming/memory/suggestion agents).
- `/chat load` dedupe fixture: same `(ts,text)` in two files, `imported_from`
  metadata.
- `cleanup-scope` mocked test: listing returns multiple cwd groups → only the
  scratch-cwd group (title-sentinel-matched) is deleted.
- Sentinel-echo negative fixture (model repeats sentinel in output → parse
  fail → corrective retry, never store corruption).
- Kiro-only machine UX: `scan`/`status`/`preferences` copy snapshots; kiro
  `missing-binary` install hint.
- Mixed-origin author run: prompt legend varies per member source.
- One **400k-char stdin probe** sequenced into P2 before consent copy is
  finalized (150 KB verified; budget-sized re-verification pending).

### 12.4 Accepted-risk register additions

- kiro-cli is auth-gated + background-auto-updating → no CI integration net
  for the kiro runner; mocked tests + fixture drill are the containment
  (§8 maintainer-testability caveat).
- `--source auto` changes dual-tool users' default corpus silently → emit a
  one-time notice line when both stores are detected ("including N kiro
  sessions; use --source claude to restore the old scope"); final call is the
  maintainer's (pre-PR issue).
- §4's interface sketch vs §11's spec differ cosmetically (classify return
  type, discover options) — **§11 is normative**; §4 remains the narrative
  overview.

### 12.5 Explicitly rejected review suggestions (with reasons)

- *Per-entry `.history`-line matching as an inclusion mechanism* — rejected
  for v1: `.history` encodes multi-line prompts lossily (`\n` escapes) and
  includes slash commands; K2 session-level precedence + K6 per-piece rules
  already cover the hybrid cases the reviewer raised. Revisit only if P4
  real-data validation shows real false-admits.
- *Renaming the package/bin as part of this work* — out of scope for the PR
  series (maintainer's prerogative; §5.8 stands).
