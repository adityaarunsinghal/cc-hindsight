# Changelog

All notable changes to cc-hindsight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.2]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.2
[1.0.1]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.1
[1.0.0]: https://github.com/adityaarunsinghal/cc-hindsight/releases/tag/v1.0.0
