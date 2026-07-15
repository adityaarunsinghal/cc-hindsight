<!--
Thanks for contributing. This codebase aims to stay reviewable: a compact
dependency tree, extraction that is documented about what it keeps and drops,
and tests that run only against synthetic fixtures. Focused PRs are easier to
review than large refactors.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link any issue. -->

Closes #

## How it was verified

<!-- Paste the commands you ran. -->

```
npm run lint && npm run typecheck && npm test && npm run build
```

## Checklist

- [ ] `lint`, `typecheck`, `test`, and `build` all pass locally.
- [ ] Tests run against synthetic fixtures only; nothing reads a real
      `~/.claude` or writes outside a temp dir.
- [ ] No new runtime dependency (the tree stays at three). If one is genuinely
      needed, the PR explains the reason.
- [ ] If this touches extraction (`src/core/extract.ts`) or dedupe, it adds a
      regression fixture for the transcript shape, per CONTRIBUTING.md.
- [ ] If this changes a distill prompt, the `*_PROMPT_VERSION` constant is
      bumped and the contract tests are updated in the same PR.
- [ ] No LLM call runs outside the consent gate.
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`…).

## Anything reviewers should look at closely?

<!-- Tradeoffs, follow-ups, or areas you're unsure about. -->
