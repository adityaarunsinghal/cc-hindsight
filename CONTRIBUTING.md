# Contributing to cc-hindsight

Thanks for helping. The bar for this codebase is simple: small enough to audit
in one sitting, honest about what it extracts, and tests that never touch
anyone's real data.

## Setup

```bash
git clone <repo> && cd cc-hindsight
npm install
npm test                 # vitest run
npm run lint             # biome check .
npm run typecheck        # tsc --noEmit
npm run build            # tsdown → dist/
node dist/cli.js --help
```

Node ≥ 22 is required (we use `util.styleText` and `util.parseArgs` via citty).
CI runs biome → typecheck → tests → build → `npm pack --dry-run` on Ubuntu and
macOS; all of it must stay green.

## Ground rules

- **Three runtime dependencies** (`citty`, `zod`, `@clack/prompts`) — keep the
  tree auditable in one sitting. A new dependency needs to clearly reduce code
  or pay for itself in UX; when in doubt, hand-roll it or leave it out.
- **Tests never read `~/.claude` or write outside temp dirs.** Every test runs
  against synthetic fixtures under `test/fixtures/`.
- **No LLM calls outside `distill` / `preferences --consolidate`**, and never
  without the consent gate. Unit tests mock the spawn layer.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, …).

## The extraction fidelity contract

`src/core/extract.ts` implements eleven audited rules (R1–R11, documented in
PLAN.md §5.4) deciding what counts as human input in Claude Code JSONL. Every
rule has a code comment citing the transcript shape it handles and a dedicated
regression fixture. This is the most safety-critical code in the repo: a bug
here silently corrupts everything downstream.

## Adding a fixture for a new transcript shape

Claude Code's JSONL format drifts. If you hit a session that exports wrongly
(human text dropped, machine text admitted), here's the drill:

1. **Find the offending line(s)** in the source file under
   `~/.claude/projects/…/*.jsonl`. Run `cc-hindsight export --verbose` — every
   dropped piece is logged with its rule and a snippet.
2. **Synthesize a minimal fixture.** Copy the *shape*, not your data: replace
   every string with something generic ("do the thing", "/tmp/x.ts"). One JSON
   object per line, smallest possible entry count. Drop it in
   `test/fixtures/extract/` with a descriptive name (`r6-new-injection-tag.jsonl`).
3. **Write the failing test** in `test/extract.test.ts` asserting exactly what
   should come out (messages in order, drops recorded).
4. **Fix the rule** in `src/core/extract.ts`, keeping the rule comment accurate.
5. If you can't fix it, file the issue with the fixture attached — a shape
   report with a synthetic fixture is the most valuable bug report we get.

The same pattern applies to discovery (`test/fixtures/claude-home/`), export
dedupe (`test/fixtures/export-home/`), and anaphora
(`test/fixtures/anaphora-home/`).

## Prompt changes

The distill prompts live in `src/claude/prompts/`. The author prompt's realism
contract (the t=0 test, the effort budget, never-copy-AI-prose) is pinned by
`test/author.test.ts` — if you change the prompt, update the contract tests
deliberately in the same PR and bump the stage's `*_PROMPT_VERSION` constant so
provenance in `sources.json` stays honest.

## Release checklist (maintainers)

```bash
npm test && npm run lint && npm run typecheck && npm run build
npm pack --dry-run        # exactly LICENSE, dist/, package.json, README
```
