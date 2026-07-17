# The kiro-cli backend

cc-hindsight reads [kiro-cli](https://docs.hub.amazon.dev/) session history the
same way it reads Claude Code: `scan` → `export` → `distill` → library +
preferences. This document records the on-disk format and the runner behavior
the implementation relies on, so the backend is reviewable without a kiro-cli
install (it is auth-gated and auto-updating; CI cannot exercise it — the
mocked-spawn tests and this document are the containment).

Verified against **kiro-cli 2.12.1** on Linux, against a real 269-session store.

## On-disk format (v2, file-based)

The store is **flat** — every session across every project lives directly under
`<kiroDir>/sessions/cli/` (default `~/.kiro/sessions/cli`):

| File | Content |
|------|---------|
| `<uuid>.jsonl` | Append-only event log; one `{version:"v1", kind, data}` object per line |
| `<uuid>.json` | Metadata: `session_id`, `cwd`, `created_at`/`updated_at`, `title`, `session_created_reason`, `parent_session_id?`, `session_state{…}` |
| `<uuid>.history` | Readline prompt history — exists **only where a human typed** |
| `<uuid>.lock` | Present while the session is active |
| `<uuid>/tasks/*.json` | Todo-list sidecar (a subdirectory, not a transcript) |

Project identity is the metadata `cwd` (exact, lossless — no dash-decoding like
Claude Code needs). Discovery groups sessions by `cwd`, records `.history`
presence, and ignores the `.json`/`.history`/`.lock` companions and the
`<uuid>/` sidecar dirs.

### Event vocabulary

| kind | data shape |
|------|-----------|
| `Prompt` | `{message_id, content:[{kind:"text", data:<string>}], meta?:{timestamp:<unix-seconds int>, additionalContext?:<string>}}` |
| `AssistantMessage` | `{message_id, content:[{kind: text\|toolUse\|thinking, data}]}` |
| `ToolResults` | `{message_id, content:[{kind: toolResult\|text}], results:{…}}` |
| `Clear` | `data: null` (a `/clear` boundary) |
| `Compaction` | `{summary, strategy, messages_snapshot}` — snapshot items duplicate earlier same-file entries |

Key facts the extractor (rules K1–K13) depends on:

- Only `Prompt` entries carry the human's verbatim text; `AssistantMessage` /
  `ToolResults` are the machine side (**K1**). Text lives in
  `content[].kind==="text"` blocks (**K4**).
- Timestamps are **unix seconds** on `Prompt.meta.timestamp` only (missing on
  ~30/410 observed prompts; tolerated as `""`, normalized to ISO-8601 elsewhere).
- `meta.additionalContext` is always machine-injected (starts
  `--- CONTEXT ENTRY BEGIN ---`, verified never to contain the human's own
  message) — **never read** as human text.
- `Compaction.messages_snapshot` duplicates earlier entries **within the same
  file** — ignored by extraction (not deduped), and both `Clear` and
  `Compaction` emit a `boundary` timeline event so an antecedent never resolves
  across a context reset (**K12**).
- No `--output-format json`, no `--json-schema`, no `--tools` flag for `chat`.

### Human-vs-automation classification (K2)

There is **no per-entry human flag** (Claude Code's `isSidechain` etc. have no
equivalent). `session_created_reason` is unreliable — it reports `"subagent"`
even for interactive human sessions (verified on-machine). Classification is
therefore session-level, with explicit precedence:

1. `.history` file present → **INCLUDE** (a human typed here; overrides every
   exclusion below, covering hybrid agent-spawned/rewind sessions a human later
   steered).
2. else `parent_session_id` set → **EXCLUDE** (a spawned child, no human).
3. else the first `Prompt` is an automation marker (`[AGENT SYSTEM PROMPT]`, a
   naming/consolidation/suggestion agent's boilerplate first line, or a lone
   harness nudge) → **EXCLUDE**.
4. else **INCLUDE** (recall-oriented default; reported under `--verbose`).

**K13**: a session whose first prompt begins with the `[cc-hindsight distill]`
sentinel is always excluded (self-recognition — the distill runner's own
auto-saved sessions must never re-enter the corpus).

On the reference store this yields 27 interactive sessions from 267 (229
automation excluded, 14 empty), and the export is byte-identical on re-run
(idempotent).

## Runner behavior (`kiro-cli chat --no-interactive`)

The distill runner drives `kiro-cli chat --no-interactive --agent
<no-tools-agent>`, prompt on stdin. Verified probe facts:

- **stdin delivery** works for multi-line prompts up to 150 KB, and was
  re-verified at the full default input budget: a **399,868-char** prompt with
  a tail needle round-tripped (needle echoed back exactly, exit 0,
  `Credits: 1.94`).
- **Tool suppression** via a local agent config
  (`<cwd>/.kiro/agents/cc-hindsight-distill.json` with `"tools": []`,
  `"mcpServers": {}`) discovered from the spawn cwd — the model reports
  `TOOLS=NONE`, no MCP startup.
- **Output** is ANSI-decorated text on stdout with a leading `> ` glyph (both
  survive redirection); there is no JSON envelope, so the runner strips ANSI +
  the glyph, then fence-strips → `JSON.parse` → zod-validates, with the schema
  embedded in the prompt.
- **Transient failure signature:** a backend hiccup ("Kiro is having trouble
  responding…") prints to **stderr**, leaves **stdout empty**, and still
  **exits 0**. The runner keys on output, not exit code: empty stdout + exit 0
  → bounded backoff (2 extra attempts, same input, *no* corrective note) beneath
  the shared corrective retry. Non-zero exit is a fatal `cli-error`.
- **Session side effects:** every run (including failed ones) auto-saves a
  session keyed to the spawn cwd (in 2.12.1, headless one-shot runs land in
  the "classic"/v1 store per the listing's `source` field — which the v2
  flat-dir *discovery* never reads, an extra layer of feedback-loop
  protection). The runner spawns from a per-run scratch cwd and, once per run
  (after all workers join), deletes only the sessions in that scratch-cwd
  group whose title starts with the sentinel — the **deletion-safety
  invariant** (never touches any other cwd group even if the listing returns
  several). K13 is the defense-in-depth backstop if a deletion is missed.

`chat --list-sessions --format json` (per cwd), `chat --delete-session <id>`
(both are flags of the `chat` subcommand in 2.12.1 — the top-level spelling is
rejected), `--list-models --format json`, and `--model` were all used/verified
in building this (probe run: created → listed → deleted → listing empty).

## Maintainer note

kiro-cli is publicly installable but auth-gated and auto-updating, so CI cannot
run it. The kiro read path is covered by synthetic fixtures
(`test/fixtures/kiro-home/`, `test/fixtures/kiro-extract/`) and the runner by
fully mocked-spawn tests (`test/kiro-runner.test.ts`), exactly like the Claude
path. The facts above are the contract those tests encode.
