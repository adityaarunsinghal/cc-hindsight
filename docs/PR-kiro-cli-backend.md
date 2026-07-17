# PR: kiro-cli backend — mine Kiro CLI sessions, distill with kiro-cli

> Draft PR description for `feat/kiro-cli-backend` → `main`. Written to be
> split per the delivery plan (docs/kiro-backend-plan.md §8): PR-1 = commit 1
> (refactor-only), PR-2 = commits 2–3 (read side), PR-3 = commits 4–7
> (runner + outputs + docs). The sections below cover the whole branch; each
> split PR can lift its slice.

## What and why

cc-hindsight currently mines only Claude Code history. This branch adds
**kiro-cli** as a second, fully supported backend — both as a *data source*
(scan/export/distill over `~/.kiro/sessions/cli`) and as a *distill runner*
(`kiro-cli chat --no-interactive`) — without changing a byte of the existing
Claude Code behavior.

A user whose agent history lives in kiro-cli gets the identical product
experience: inventory sessions, export human-only markdown, distill a oneshot
library, and emit paste-ready preferences (now targeting `CLAUDE.md`, a kiro
steering file, or `AGENTS.md`). Dual-tool users get a merged corpus by default.

Design evidence (on-disk format census over a real 267-session store, live
headless probes of stdin delivery / tool suppression / session persistence /
the empty-stdout failure signature) is recorded in `docs/kiro-backend.md` and
the full plan in `docs/kiro-backend-plan.md` — the backend is reviewable
without a kiro-cli install.

### How it's built

- **Post-extraction seam** (commit 1, refactor-only): `ExtractedMessage`,
  `Drop`, `ExtractResult`, `TimelineEvent` move to `src/sources/types.ts` as
  the shared currency; a `SessionSource` (discover/extract/timeline/classify)
  produces them and nothing downstream parses raw lines again. The runner
  splits into `src/runners/shared.ts` (IO, errors, spawn) + per-backend
  runners. Re-export shims at `src/core/extract.ts`, `src/core/discover.ts`,
  and `src/claude/runner.ts` (including a `ClaudeRunnerError` class alias)
  keep every existing import and `instanceof` working — 17 of 20 pre-existing
  test files are untouched.
- **kiro read side** (commits 2–3): flat-store discovery grouped by metadata
  `cwd` (lossless, no dash-decoding), extraction rules K1–K13 mirroring the
  Claude R-rules, and **session-level** human-vs-automation classification
  (kiro has no per-entry `isSidechain` equivalent): `.history` present →
  include (overrides everything); else `parent_session_id` → exclude; else
  automation-marker first prompt → exclude; else include (recall-oriented).
  Timestamps normalize unix-seconds → ISO-8601; missing stays `""` (no
  fabricated timestamps — they would defeat dedupe for rewind/`/chat load`
  copies and pollute provenance).
- **kiro runner** (commit 4): schema embedded in the prompt + zod (no
  envelope/`--json-schema` exists), ANSI + `> ` glyph stripping, tools
  disabled via a generated local no-tools agent in a per-run scratch cwd.
  kiro's observed transient failure (empty stdout + **exit 0**) gets a bounded
  transport retry (2 attempts, 500 ms/2 s backoff) *beneath* the shared
  one-shot corrective retry. Every headless run auto-saves a session into the
  user's store, so the runner enforces a **deletion-safety invariant**: after
  the run it deletes only sessions whose listing group cwd is exactly the
  scratch dir AND whose title starts with the `[cc-hindsight distill]`
  sentinel; extraction rule K13 independently rejects sentinel sessions so
  the corpus can never ingest its own distill prompts even if cleanup misses.
- **Flags** : `--source claude|kiro|auto` (default `auto`: read whichever
  stores exist), `--kiro-dir` / `KIRO_CONFIG_DIR`, `distill --runner
  claude|kiro|auto` (auto prefers the CLI matching the source, falls back by
  availability), `preferences --target claude|kiro|agents`. The export
  manifest gains an additive `origin` field (`origin ?? "claude"` for old
  manifests); the prune rule only runs on unfiltered **auto** runs so a
  `--source claude` run can never delete kiro exports.

Closes # (pre-PR issue per plan §8 — file before opening PR-1)

## How it was verified

```
npm run lint && npm run typecheck && npm test && npm run build \
  && npm pack --dry-run --json > pack.json && node scripts/check-pack.mjs pack.json
```

- 25 test files, **371 tests passing** (1 todo), lint/typecheck/build/pack all
  green (the exact prepublish/CI sequence).
- **Byte-parity against upstream v1.0.2**: both versions were run over the
  same frozen real Claude store (302 sessions, 61 exported). Every exported
  `.md`, `anaphora.json`, and `outcomes.json` is **byte-identical**;
  `manifest.json` differs only by the additive `origin` field; the summary
  stats line is byte-identical. The refactor is provably zero-behavior-change
  on the Claude path.
- **Real-data validation** (kiro store on the development machine): 271
  sessions → 28 interactive exported, 229 automation sessions excluded with
  per-session reasons under `--verbose`, zero unexplained drops; export
  re-run is byte-identical (idempotent). Merged dual-store run reports
  `exported 89 sessions (61 claude + 28 kiro; …)`.
- New tests: kiro discovery (fixture store with metadata/history/lock/sidecar
  companions), K-rule extraction fixtures, an extract↔timeline agreement test
  (the index-alignment law), mocked-spawn runner tests covering the ANSI happy
  path, empty-stdout backoff (same input, no corrective note), retry
  exhaustion, corrective retry, timeout, and a **cleanup-scope test** proving
  sessions from other cwd groups and non-sentinel titles survive cleanup —
  including after a failed call.

## Checklist

- [x] `lint`, `typecheck`, `test`, and `build` all pass locally.
- [x] Tests run against synthetic fixtures only; nothing reads a real
      `~/.claude` **or `~/.kiro`**; spawn is always mocked.
- [x] No new runtime dependency (the tree stays at three;
      `stripVTControlCharacters` and `mkdtemp` are node builtins).
- [x] Extraction changes add regression fixtures (`test/fixtures/kiro-extract/`,
      `test/fixtures/kiro-home/`, `test/fixtures/kiro-home-dedupe/`); the
      Claude fixtures are untouched and green.
- [x] The distill prompts gained source-aware copy, so
      `DIGEST/CLUSTER/AUTHOR_PROMPT_VERSION` were bumped (2/3/3) with contract
      tests updated in the same branch (`test/prompts-source-aware.test.ts`);
      claude-origin prompt text is unchanged.
- [x] No LLM call runs outside the consent gate; consent copy names whichever
      CLI will actually run (`claude` copy is byte-identical to before).
- [x] Conventional Commits throughout (7 commits matching the plan's map).

## Anything reviewers should look at closely?

1. **Commit 1's re-plumbing of `buildCorpus`/`buildAnaphora`/`buildOutcome`**
   — it rewires the sacred index-alignment invariant. Mitigations: the
   SessionSource law is enforced by a dedicated agreement test, the lazy
   timeline map is keyed by `sourcePath` (the same unique key the old
   `linesBySource` map used), and the byte-parity run above is the
   end-to-end proof.
2. **Runner cleanup timing**: session-store cleanup runs ONCE per run via
   `AgentRunner.finalize`, invoked at every terminal point after stage calls
   began — after all concurrent workers join, so one worker's cleanup can
   never list-and-delete a sibling's in-flight session. The deletion-scope
   invariant (exact scratch cwd + sentinel title) is pinned by mocked tests.
3. **kiro-cli is auth-gated and auto-updating** — CI cannot exercise the real
   binary. The mocked tests + `docs/kiro-backend.md` (verified against
   kiro-cli 2.12.1) are the containment; we offer to be maintainer-of-record
   for the kiro runner path.

### Follow-up round (all previously-listed gaps closed)

A remediation pass closed every gap the original audit listed:

- **Source-aware distill prompts** (digest/cluster/author): the prompt names
  each session's backend ("Kiro CLI session", neutral "coding-agent" for
  merged corpora) and the `[decision]`/`[command]`/`[image pasted]` legend is
  explained only for sources that can produce it. Claude-origin prompts are
  byte-compatible with the previous copy. `DIGEST/CLUSTER/AUTHOR_PROMPT_VERSION`
  bumped (2/3/3) with contract tests, including a mixed-origin task test.
- **Copy surfaces**: `copy.ts` paste hint is backend-neutral; `status.ts`'s
  vestigial "(claude dir not found)" replaced; the status `discovered` line
  gains a `(N claude, M kiro)` breakdown when both stores are active; help
  text de-branded (`scan`, `preferences`, per-runner-call flags).
- **Observability**: K11 — a non-text kiro Prompt block now yields the R11
  placeholder (`[image pasted]`) or an explicit `Drop` (never silent); K12 —
  a Compaction-snapshot prompt that never appears live is recorded as a
  `Drop("K12: snapshot-only prompt")`; orphan `.history` files (transcript
  deleted) are surfaced by `scan` and `status`.
- **Runner**: the corrective-retry loop and schema embedding are now shared
  (`runWithCorrectiveRetry`/`embedSchema` in `runners/shared.ts`); session
  cleanup moved from per-call to ONCE per run via `AgentRunner.finalize`
  (after all concurrent workers join — removing the cross-worker deletion
  race); the scratch cwd is home-scoped (`<home>/runner-scratch/run-*`,
  owner-only) with an OS-tmpdir fallback; explicit `--runner claude|kiro`
  fails at RESOLVE time (before consent) when the binary is missing; the kiro
  `Credits:` stderr footer is accumulated and reported in the distill summary.
- **Registry**: `--source auto` now requires a store to hold ≥1 project;
  merged runs print a one-time notice (`including N kiro session(s); use
  --source claude to restore the claude-only scope`).
- **Fixtures/tests**: hybrid rewind-with-history classification (K2 step-1
  precedence over the parent link), `/chat load` `imported_from` dedupe
  (copied keys owned by the original), sentinel-echo negative runner test,
  anaphora boundary-stop unit tests, orphan-history fixtures, runner-registry
  tests. Suite: 371 tests across 25 files.
- **400k-char stdin probe (P2 exit criterion)**: a 399,868-char prompt with a
  tail needle round-tripped through `kiro-cli chat --no-interactive` (needle
  echoed exactly, exit 0). The probe also caught a REAL BUG: in kiro-cli
  2.12.1 `--list-sessions`/`--delete-session` are flags of the `chat`
  subcommand — the runner's cleanup helpers previously invoked them top-level
  and would have silently no-oped. Fixed and re-verified end-to-end
  (created → listed → deleted → listing empty). Also documented: headless
  one-shot sessions persist to the "classic"/v1 store in 2.12.1, which v2
  flat-dir discovery never reads — an extra feedback-loop layer on top of the
  scope invariant and K13.

### Remaining accepted limitations

- Slash-command fidelity: kiro loses R10-style `[command]` recovery by design
  (commands never reach the transcript) — documented in
  `docs/kiro-backend.md`, not a bug.
- kiro-cli is auth-gated and auto-updating — CI cannot exercise the real
  binary; mocked tests + the probe-fact document are the containment.
