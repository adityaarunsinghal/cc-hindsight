# Security

cc-hindsight reads your Claude Code conversation history, so its security
posture and its privacy posture are the same thing. The design goal is a data
path that is small enough to review directly.

## The trust model

- **Local-only.** Everything is read from your disk and written to your disk
  (`~/.cc-hindsight`, owner-only permissions). There is no server, no account,
  and no telemetry. The only outbound call is your own `claude` CLI doing what
  it already does when you use Claude Code.
- **Consent-gated spend.** No LLM call happens until `distill` has printed the
  exact invocation count and you have answered `[y/N]`. `--dry-run` shows the
  full plan and calls nothing.
- **Pinned dependencies.** There are three runtime dependencies, and the whole
  transitive tree is locked via `npm-shrinkwrap.json`.
- **Verifiable builds.** Releases published through the `release.yml` workflow
  carry an npm provenance attestation that links the tarball to the commit and
  CI run that built it.

## Your exported data

`export` writes your raw prompts to `~/.cc-hindsight/exports`, including
anything sensitive you once pasted into a session (keys, internal hostnames,
private notes). Those files never leave your machine. Two things to know:

- Treat `~/.cc-hindsight` like any other directory of personal notes. It is not
  encrypted at rest beyond your filesystem's own permissions.
- Before sharing a oneshot or an export publicly, read it first. A `--redact`
  option is on the roadmap; until then, redaction is manual.

## Reporting a vulnerability

If you find a security or privacy issue (for example, a path that writes
outside `~/.cc-hindsight`, an unexpected network call, or a way tool output
leaks data you did not consent to send), please report it privately rather than
opening a public issue:

- Use GitHub's [private vulnerability
  reporting](https://github.com/adityaarunsinghal/cc-hindsight/security/advisories/new)
  for this repository, or
- Reach the author through [adityasinghal.com](https://adityasinghal.com).

Please include the version (`cc-hindsight --version`), your OS, and the
smallest reproduction you can share. Expect an acknowledgement within a few
days. Because this is a solo-maintained project, please allow reasonable time
for a fix before any public disclosure.

## Supported versions

This is pre-2.0 software under active development. Security fixes land on the
latest released version; please upgrade to the newest `cc-hindsight` before
reporting.
