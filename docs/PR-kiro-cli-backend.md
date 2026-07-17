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

- 23 test files, **333 tests passing** (1 todo), lint/typecheck/build/pack all
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
      `test/fixtures/kiro-home/`); the Claude fixtures are untouched and green.
- [x] No distill prompt text changed in this branch, so no `*_PROMPT_VERSION`
      bump (see known gaps — source-aware prompt copy is a follow-up that will
      carry its own bumps).
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
2. **Runner cleanup timing**: cleanup runs after each call (in `finally`)
   rather than once at distill end. Under `--concurrency 3` one worker's
   cleanup may delete a sibling's in-flight auto-saved session (same scratch
   cwd + sentinel title). Believed harmless — kiro-cli holds its
   conversation in memory and the session would be deleted moments later
   anyway — and the scope invariant guarantees user sessions are never
   touched. Flagging because the plan originally specified once-after-join.
3. **kiro-cli is auth-gated and auto-updating** — CI cannot exercise the real
   binary. The mocked tests + `docs/kiro-backend.md` (verified against
   kiro-cli 2.12.1) are the containment; we offer to be maintainer-of-record
   for the kiro runner path.

### Known gaps (deliberate, tracked as follow-ups)

- **Source-aware distill prompt copy (plan W5)**: digest/cluster prompts still
  say "Claude Code session" for kiro-sourced content, and the
  `[decision]`/`[command]`/`[image pasted]` legend is included regardless of
  source. Mechanically harmless (the content itself is source-agnostic) but
  the copy should be parameterized, with prompt-version bumps, in a follow-up.
- Two residual Claude-branded copy surfaces: `copy.ts` ("paste it into a fresh
  Claude Code session.") and `status.ts` ("(claude dir not found)"); the
  status `discovered` line does not yet show a `(Y claude, Z kiro)` breakdown.
- Observability niceties from the plan's review round: a placeholder + `Drop`
  for a hypothetical non-text kiro Prompt block (0/410 observed), a `Drop` for
  Compaction-snapshot-only prompts, and surfacing orphan `.history` files
  (transcript deleted) in scan/status.
- `Credits: <n>` stderr parsing for a per-run cost total (nice-to-have).
- Fixture backlog: hybrid rewind-with-history classification (the precedence
  code handles it; add the companion-triple fixture), `/chat load`
  `imported_from` dedupe fixture, a sentinel-echo negative fixture, and a
  direct unit test that `boundary` events stop antecedent/decision search.
- stdin prompt delivery is probe-verified to 150 KB; one budget-sized
  (400k-char) verification call should be run before heavy production use.
