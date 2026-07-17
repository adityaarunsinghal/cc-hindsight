# Changelog

All notable changes to cc-hindsight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/adityaarunsinghal/cc-hindsight/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.2
[1.0.1]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.1
[1.0.0]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.0
