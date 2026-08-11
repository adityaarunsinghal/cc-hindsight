# Changelog

All notable changes to cc-hindsight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Windowed clustering for corpora that exceed the input budget.** The
  cluster stage previously sent one prompt over ALL digests and merely warned
  when that prompt exceeded `--input-budget`. Now it splits the corpus into
  deterministic windows whose prompts each fit the budget, clusters every
  window independently (same validation and corrective retry per window), and
  unifies cross-window duplicate tasks with one best-effort merge call over
  the task identities. A failed or partially invalid merge response degrades
  to the still-valid unmerged union with a note, never a lost run. Nothing
  changes for corpora that fit: a single call as before.

### Fixed

- **A windowed clustering merge could write an unusable task slug.** Every other
  cluster response passes `validateCluster` before anything is saved, but the
  merge call runs after per-window validation and its schema types the
  replacement slug as a plain string, so a response of `"Payments Work"` (or
  `"../../escaped"`) was applied verbatim. A task slug is also a path component
  (`library/<slug>/…`), so that reached the filesystem. Malformed replacement
  slugs are now skipped with a note, keeping the still-valid unmerged union.
  Relatedly, de-duplicating a colliding slug appended a sixth word to an
  already-5-word slug, which `validateCluster` rejects; the suffix now replaces
  the final word instead, so both the merge and cross-window collision paths
  stay within the 2-5 word rule. Only reachable on the windowed path.
- **A finished run could still refuse to exit.** Settling a spawn on child
  `exit` (v1.2.0) fixed the await-side hang, but the settled child's stdio
  streams were never destroyed. Whenever a grandchild inherited the pipes or
  the child was killed mid-write (a timed-out call), those streams stayed
  ref'd and held the event loop open after all work was done. Observed live:
  a finished `distill` lingered 20+ minutes holding exactly two orphaned
  child-stdio sockets; destroying them via an attached inspector made it exit
  immediately. The runner spawn now destroys the child's stdio on every settle
  path, and the clipboard spawn unrefs its child and stdin so a hanging
  clipboard tool can never hold the process either.
- **Preferences consolidation timed out on large stores.** Same defect family
  as the clustering timeout below: consolidation is a single call over EVERY
  aggregated preference but inherited the flat 5-minute default, and died at
  exactly 300000ms twice on a real 80+ preference store (which is also what
  triggered the lingering-exit hang above). The default now scales with the
  preference count (5 min base + 5s each); `preferences` gained a `--timeout`
  flag, and `distill --timeout` reaches the end-of-run cascade's call too.
- **Clustering timed out on large stores.** The cluster stage is a single call
  over ALL digests, but it inherited the flat 5-minute per-call default sized
  for one-session digest calls; at 84 digests the call reliably exceeded it and
  the run stopped at `✗ claude invocation timed out after 300000ms`. The
  cluster call's default timeout now scales with input size
  (5 min base + 5s per digest; 12 min at 84). An explicit `--timeout` still
  passes through unscaled, on the corrective retry too.

## [1.2.0] - 2026-08-02

### Fixed

- **A finished `distill` run could hang forever instead of exiting.** The spawn
  helper resolved on the child's `close` event, which fires when the stdio pipes
  close rather than when the child exits. A CLI that execs a wrapper or starts
  background helpers (one observed wrapper launches MCP servers) can exit while a
  grandchild still holds the inherited stdout, so the runner waited on that
  grandchild and the per-call timeout was powerless: its SIGTERM went to a process
  that had already gone. Observed on a real 87-session run, which sat idle for
  10+ minutes after its final output with all work already saved. Spawning now
  settles on whichever of `exit` or `close` arrives first, with a macrotask for
  buffered output to flush (verified lossless to 4MB).
- **The clipboard offer had no timeout.** `xclip` with no usable X display holds
  the selection indefinitely rather than failing, and the copy offer is the last
  thing a run does, so a finished run looked hung. Copying is now bounded
  (5s, `CLIPBOARD_TIMEOUT_MS`) and reports the timeout; the block is on screen
  regardless. Its spawn also settles on `exit` and tolerates EPIPE, matching the
  runner.
- **`distill` failed on every call when Claude Code verbose mode is on.** With
  `"verbose": true` in `settings.json` (or `--verbose`), `claude -p
  --output-format json` emits a JSON **array** of stream events terminated by
  the `type: "result"` event instead of a single result object. The runner read
  the array as an object, found no `result`, and failed every digest, cluster,
  and author call with `claude envelope missing a 'result' field` after burning
  its one corrective retry — so a whole distill run died at the clustering
  stage with no usable output. Both payload shapes are now accepted (the result
  event is located by its `type` field, whose key position is not stable).
  There is no `--no-verbose` flag to force the object shape, so tolerating the
  array is the only fix available to a caller.
- **Undiagnosable envelope errors.** A missing `result` now reports a snippet of
  the actual stdout; a verbose stream that ends without its terminal event says
  so explicitly instead of blaming a missing field.
- **Capability probe under-detected on wrapper distributions.** A distribution
  wrapper (observed in the wild: a `claude` that resolves credentials and model
  routing, then execs the native binary) documents only its own options in
  `--help` and forwards unknown flags through. Its help advertised neither
  `--json-schema` nor `--tools`, yet both work when passed, so the probe read
  `{jsonSchema: false, disableTools: "none"}` and silently degraded every
  distill stage to the prompt-embedded schema with tools disabled by
  instruction alone. When `--help` does not look like the native help (no
  `--output-format`), the probe now re-checks once via `--claude-help` and
  prefers that answer if it finds more. Verified against the real wrapper:
  the probe now reports `{jsonSchema: true, disableTools: "tools-empty"}`.
- **An answer typed without a trailing newline inverted consent.** readline
  discards a final line that arrives with no newline, so an answer terminated by
  EOF (`printf y |`, or Ctrl-D straight after the keystroke) resolved to `""` and
  was read as the prompt's default. Seen in the wild as
  `Proceed? [y/N] ydeclined; nothing was invoked.`: the `y` echoed and was then
  thrown away. This cut both ways, since a newline-less `n` against one of the
  default-Yes offers was read as yes. `ask()` now taps the raw bytes and falls
  back to their first line, so a newline-less answer is honored while a genuine
  no-input EOF still takes the default.
- **A fenced JSON reply wrapped in any prose defeated `stripFence`.** The pattern
  was anchored to the whole string, so a single `Here you go:` preamble or a
  `Hope that helps!` sign-off around an otherwise perfect ```json block left the
  fence in place, the parse failed, and the stage burned its one corrective
  retry. An uppercase ```JSON tag was captured into the body for the same reason.
  This is the last line of defense whenever the CLI cannot validate server-side
  (no `--json-schema`, and always for the kiro runner), and the live model does
  fence its output on that path even when told to answer with JSON only. Fence
  detection is now unanchored and case-insensitive, takes the first block when
  several are emitted, and still passes non-fenced text and unterminated fences
  through untouched so error snippets keep showing the real content.
- **R3 dropped every message typed while the agent was busy.** Claude Code writes
  a queued prompt's text in the attachment's `prompt` field; the extractor read
  `text`, found nothing, and recorded a drop. Because the fixture pinning R3 was
  hand-authored with `text`, the suite validated a shape no CLI emits and the
  loss was invisible. Measured on a real 286-session store: **673 → 920 messages
  exported (+247, a 36.7% increase)**, recovering all 253 human queued messages
  (~42.9k chars). Every follow-up typed mid-run ("its ok let it cook", "putting
  you back in plan mode") was being thrown away, so digests and authored oneshots
  were built from a corpus missing a third of its input. `text` is still read as a
  fallback.
- **Drop reports dumped raw JSON for attachments.** `entrySnippet` also only knew
  `text`, so every dropped attachment fell through to serializing the whole entry,
  making `export --verbose` unreadable (and camouflaging the bug above as machine
  noise). Attachments now report their `prompt`/`text`, or `<attachment type>`
  when they carry no human-readable payload.
- **K14: kiro dropped every mid-run steering message.** When the human types
  while kiro is working, the harness does not record a new `Prompt`: it wraps the
  words in a `[LIVE STEERING - New message from user]` envelope and appends that
  to the NEXT `ToolResults` entry. K1 admits only `Prompt` entries, and K6 dropped
  the envelope on its bracket marker, so the text was invisible either way.
  Measured on a real 306-session store: **312 to 411 messages exported (+99, a
  31.7% increase)**, recovering all 112 steering messages (~13.6k chars). These
  are the turns where the human corrects course mid-run ("i kinda need you to
  hurry up please", "git history, code and log.md never lie"), so they carry more
  signal per character than almost anything else in a session. Only the
  `<user_message>` body is admitted: the harness instructions around it stay out,
  and the 5630 `toolResult` blocks in those same content arrays are untouched.
  Recovery runs in both `extract` and `timeline`, so the SessionSource law holds
  (verified on the real store: 306 files, 485 messages, 0 violations).

### Added

- **SessionSource law test for the Claude backend** (`extract` ↔ `timeline`
  agreement across 11 fixtures). kiro has had one since the multi-backend seam
  landed; the Claude side did not, which is how a rule could halve the corpus
  without a single test failing. Also verified against the real store: 286
  sessions, 970 messages, 0 violations.
- **Systemic-failure breaker on the digest stage.** Five consecutive
  byte-identical failures now stop the stage instead of grinding through every
  remaining session. Per-session containment is right for a session-specific
  problem, but an unbroken streak of the same error is an environment problem (a
  reshaped CLI envelope, a revoked credential), and each failure also burns the
  runner's one corrective retry, so continuing buys the same error at two calls
  apiece. Measured on a 12-session live run where every call failed: 5 sessions
  attempted instead of 12, saving 14 doomed invocations, and the report names the
  environment as the likely cause rather than listing 12 identical errors.
  Anything already digested stays checkpointed, sessions that were never reached
  are reported as `not attempted` so the count is never silently short, and
  `--no-breaker` restores the attempt-everything behavior.

## [1.1.0] - 2026-07-17

### Added

- **kiro-cli backend.** cc-hindsight now mines kiro-cli session history
  (`~/.kiro/sessions/cli`) alongside Claude Code. New `--source
  claude|kiro|auto` (default `auto`: read whichever stores exist) and
  `--kiro-dir` / `KIRO_CONFIG_DIR` flags on every command; the export manifest
  tags each session's `origin` and a merged run breaks the count down
  (`9 claude + 3 kiro`).
- **Runner selection.** `distill --runner claude|kiro|auto` chooses which local
  CLI distills, orthogonal to `--source`; `auto` prefers the CLI matching the
  source, else whichever is installed (a kiro-only machine works out of the box).
  The kiro runner adds a bounded empty-stdout transport backoff beneath the
  existing corrective retry, and cleans up the sessions kiro auto-saves per run.
- **Preferences targets.** `preferences --target claude|kiro|agents` emits a
  `CLAUDE.md` block, a `~/.kiro/steering/` file, or a portable `AGENTS.md`
  section (default inferred from `--source`).
- **Source-aware distill prompts.** Digest/cluster/author prompts name each
  session's backend (neutral "coding-agent" for merged corpora) and only
  explain the `[decision]`/`[command]`/`[image pasted]` legend for sources
  that produce it; `DIGEST/CLUSTER/AUTHOR_PROMPT_VERSION` bumped (claude-origin
  prompt text unchanged).
- **Observability.** Non-text kiro Prompt blocks render the `[image pasted]`
  placeholder or an explicit drop (K11); Compaction-snapshot-only prompts are
  recorded as drops (K12); orphan kiro `.history` files (transcript deleted)
  are surfaced by `scan`/`status`; merged `--source auto` runs print a
  one-time notice with the `--source claude` escape; `status` breaks the
  discovered count down per source; the kiro runner reports total
  `Credits:` spent per distill run.
- **Colorful distill flow.** Each stage prints a banner (`── digest ───── 5
  session(s)`) with a bold label, dim rule, and cyan count for digest, cluster,
  author, and budget; per-item lines gain colored status glyphs (green `✔`,
  red `✗`, yellow `⤬`) and stage summaries turn green when nothing failed.
- **Preferences clipboard offer.** At the end of a `preferences` run,
  cc-hindsight offers to copy the rendered block to the clipboard (enter =
  yes; `--yes` copies without asking; silent in pipes) and prints paste
  guidance naming the target file (`CLAUDE.md`, kiro steering, or `AGENTS.md`).
- **Distill preferences cascade.** After a successful `distill`, a press-enter
  cascade offers to consolidate the freshly observed preferences (one runner
  call, cost named in the prompt) and then copy the result to the clipboard,
  closing the loop from history to a paste-ready guidance block.
- **Git-ref installs.** A `prepare` script builds `dist` on install, so
  `npx github:adityaarunsinghal/cc-hindsight#<ref>` works from any branch,
  tag, or commit; the build's output routes to stderr so `npm pack --json`
  capture stays parseable on every npm version (with `--ignore-scripts` kept
  where npm honors it).

### Changed

- The package description and keywords are de-branded to the coding-agent
  framing, naming both Claude Code and kiro-cli (new keywords `kiro`,
  `kiro-cli`, `agents`); the root `--help` and README intro follow suit.

- Internal refactor: extraction, discovery, and the runner moved behind a
  source-agnostic `SessionSource` / `AgentRunner` seam (`src/sources/`,
  `src/runners/`) with re-export shims at the old paths. Zero behavior change on
  the Claude Code path (export output byte-identical), verified against a golden
  reference.

## [1.0.2] - 2026-07-15

### Fixed

- The license badge in the README pointed at an npm registry endpoint that
  intermittently rendered "package not found"; it now reads the license GitHub
  detects, so it reliably shows MIT.

## [1.0.1] - 2026-07-15

### Added

- A demo GIF at the top of the README showing a real run.
- SECURITY policy, this changelog, a pull-request template, and an issue-template
  config that routes questions to Discussions.

### Changed

- Documentation reads in a plainer voice throughout.

## [1.0.0] - 2026-07-15

First public release.

### Added

- **One-command flow.** `distill` offers to run `export` first when nothing has
  been exported yet, and offers to show the finished library when it is done,
  so `npx cc-hindsight distill` can build and display a library end to end.
- **Parallel authoring.** The author stage runs calls concurrently through the
  same bounded worker pool as digest. A shared `--concurrency` flag (default 3)
  drives both stages; results stay in a deterministic order.
- Trusted-Publishing release workflow: tagged releases publish to npm over OIDC
  with a provenance attestation and no stored token.

### Changed

- `renderMarkdownAnsi` now honors its explicit `color` flag instead of letting
  Node's stream auto-detection strip styling in non-TTY contexts.
- The consent prompt tolerates an already-exhausted stdin instead of hanging on
  a second question.

### Pre-1.0 history

Earlier `0.1.x` releases built up the core: read-only `scan`, the deterministic
`export` with its audited extraction contract (rules R1–R11) and cross-file
dedupe, the consent-gated three-stage `distill` pipeline (digest, cluster,
author), library browsing and curation (`list`, `show`, `copy`, `edit`, `rate`,
`prune`, `status`), the `preferences` CLAUDE.md aggregator, input budgets, and
hardened packaging.

[Unreleased]: https://github.com/adityaarunsinghal/cc-hindsight/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.2.0
[1.1.0]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.1.0
[1.0.2]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.2
[1.0.1]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.1
[1.0.0]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.0
