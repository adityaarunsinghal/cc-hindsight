# cc-hindsight

> **The prompt you'd write if you knew then what you know now.**

```bash
npx cc-hindsight
```

cc-hindsight mines your Claude Code session history into two things you can use
tomorrow morning:

1. **A oneshot prompt library** — for each real task you've done, the realistic
   ideal *first* prompt: everything you knew and wanted at t=0 but didn't say,
   written in your own voice.
2. **A distilled preference set** — the things you keep re-telling your agent
   ("diagnose before acting", "pin the versions", "be terse"), surfaced as a
   paste-ready `CLAUDE.md` block so every future session starts aligned.

![demo](docs/demo.gif) <!-- TODO: record demo GIF -->

## The t=0 problem

You get better results the more context you front-load into your first prompt —
yet almost everyone under-specifies at t=0 and spends the session steering:
correcting course, restating preferences, answering questions the agent
shouldn't have had to ask.

All the evidence of what you *should* have said is already on disk. Claude Code
saves every session as JSONL under `~/.claude/projects/`. Plenty of tools read
that data for dashboards and transcripts. **Nobody closes the loop from history
back to better prompting.**

**Before** (what you actually typed at t=0):

> fix my CI

**After** (what cc-hindsight distills from how that session — and two more like
it — actually went):

> Set up CI for this repo: lint, typecheck, tests, and build as separate steps.
> Pin every action version — no floating tags. Node 22, npm cache on. If a step
> is flaky, make it fail loudly rather than retry silently; I'd rather see it.
> Keep the workflow file boring and readable. When you're unsure about my
> setup, ask before assuming.

The second prompt was knowable at t=0. You just hadn't written it yet.

## Quickstart

```bash
npx cc-hindsight            # 1. scan — inventory your projects (read-only)
npx cc-hindsight export     # 2. export — human-only markdown per session
npx cc-hindsight distill    # 3. distill — digest → cluster → author (asks first)
```

Then browse the results:

```bash
npx cc-hindsight list                # your library
npx cc-hindsight show <slug>         # read a oneshot
npx cc-hindsight copy <slug>         # → clipboard, paste into a fresh session
npx cc-hindsight preferences         # → CLAUDE.md block
npx cc-hindsight status              # pipeline funnel + orphan/skip flags
```

Requires Node ≥ 22. `scan` and `export` are fully deterministic — no LLM, no
network. `distill` uses the `claude` CLI you already have, and never without
asking.

## Privacy & trust

For a tool that reads your entire conversation history, auditability is the
product:

- **Local-only.** Everything is read from your disk and written to your disk
  (`~/.cc-hindsight`). No server, no accounts, no telemetry — and no network
  calls, ever, except your own `claude` CLI doing what it already does.
- **Three runtime dependencies.** [`citty`](https://github.com/unjs/citty)
  (zero-dependency CLI framework), [`zod`](https://zod.dev) (schema
  validation), and [`@clack/prompts`](https://github.com/bombshell-dev/clack)
  (progress spinners — two micro-packages under the hood). The whole data
  path is small enough to audit in one sitting.
- **Consent-gated LLM use.** `distill` states the exact invocation count and
  waits for `[y/N]` before anything runs on your subscription/credits.
  `--dry-run` shows the full plan for free. Declining is exit code 2, never a
  partial run.
- **Plain statement:** exports contain your raw prompts — including anything
  sensitive you ever pasted into a session (keys, internal names, that one
  angry message). They live in your home directory with your permissions, and
  nothing ships them anywhere. A `--redact` option is on the roadmap.

## How it works

```mermaid
flowchart TD
    A["~/.claude/projects/**/*.jsonl"] -->|"scan (read-only)"| B["inventory"]
    A -->|"export (deterministic)"| C["exports/*.md + manifest.json"]
    A -->|"anaphora + outcome evidence"| D["anaphora.json + outcomes.json"]
    C --> E
    D --> E
    subgraph distill ["distill — opt-in, consent-gated, resumable"]
        E["digest: 1 claude call / session"] --> F["cluster: 1 call"]
        F --> G["author: 1 call / task"]
    end
    G --> H["library/&lt;slug&gt;/ oneshot + provenance"]
    H --> I["list / show / copy / status"]
    H --> J["preferences → CLAUDE.md block"]
```

The extraction layer is a fidelity contract: eleven audited rules decide what
counts as human input (attachments typed while the agent was busy, recovered
slash commands, `[decision]` lines from option picks, `[image pasted]`
markers), with a regression fixture per rule. Fork/resume duplicates are
deduped globally. Short replies like "yes" and "option 2" get their antecedent
attached so the author stage never guesses what you approved. Sessions carry an
outcome classification — tasks where nothing ever succeeded are skipped, not
distilled into confident prompts that reproduce failure paths.

Authored oneshots pass a **"knowable at t=0" test**: front-load intent,
constraints, preferences, quality bars; never front-load facts you only
discovered mid-session (paths, root causes, error messages). And they respect
an **effort budget** — the length a motivated human would actually type, not a
700-word spec.

Every distill stage checkpoints to disk after each unit of work: Ctrl-C loses
nothing, re-running resumes, `--fresh` resets deliberately, and `status` flags
library entries orphaned by re-clustering.

## How it compares

| Tool | Reads `~/.claude` | Output | Direction |
|---|---|---|---|
| ccusage | ✓ | usage/cost tables | backward (metrics) |
| sniffly | ✓ | analytics dashboard | backward (behavior) |
| claude-code-transcripts | ✓ | shareable HTML transcripts | backward (record) |
| cctrace / exporters | ✓ | markdown/XML exports | backward (archive) |
| **cc-hindsight** | ✓ | **oneshot prompt library + CLAUDE.md preferences** | **forward (better next session)** |

Closest kin is Simon Willison's `claude-code-transcripts` — same local-first
values, same belief that transcripts are undervalued artifacts. The difference
is the direction of gaze: it renders your sessions (backward, for others); we
distill them (forward, for you).

## FAQ

**Does my data leave my machine?**
No. The deterministic commands never touch the network. `distill` pipes
content to your locally installed `claude` CLI — the same thing that happens
when you use Claude Code — and nothing else.

**What does distill cost?**
Whatever your `claude` CLI costs you: it runs on your existing subscription or
API credits. The consent prompt states the exact invocation count up front
(one call per session digested, one to cluster, one per task authored), and
`--dry-run` prints the same plan without running anything. Checkpoints mean an
interrupted run isn't wasted money.

**Subscription or API?**
Either. cc-hindsight shells out to `claude -p`; however your CLI is
authenticated is how the calls are billed. `--model` passes through.

**Why is a session missing from my exports?**
Sessions with zero human messages are skipped naturally, `--min-messages`
filters thin ones, and fork/resume copies are deduped into their original
session. Run `export --verbose` to see every dropped piece with a reason — and
if genuine human input was dropped, that's a bug: file an extraction-fidelity
report.

**Can I regenerate everything from scratch?**
`cc-hindsight distill --fresh` clears the checkpoints (after confirming) and
re-runs. Old library entries from previous generations are flagged as orphans
in `status`.

## Roadmap

- Claude Code **plugin packaging** for existing marketplaces (distribution,
  not a marketplace of our own)
- An in-session **skill variant** ("distill this session as we go")
- **Agent SDK** orchestration exploration
- **parentUuid-aware anaphora** (branch-correct antecedents on forked
  conversations)
- **`--redact` patterns** for exports
- An opt-in **community oneshot showcase**

## Development

```bash
npm install
npm test            # vitest — fixtures only, never reads your ~/.claude
npm run lint        # biome
npm run typecheck   # tsc --noEmit
npm run build       # tsdown → dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — especially the guide to adding a
fixture when you hit a transcript shape we don't handle.

## License

[MIT](LICENSE)
