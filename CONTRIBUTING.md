# Contributing

Thanks for looking. Engram is a small project with a strong opinion about how memory should work, so the fastest way to land a change is to know where the lines are.

## Getting set up

Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

The app opens with an empty vault. Point it at a scratch folder — never your real notes while developing.

## Before opening a PR

```bash
pnpm run check      # typecheck, lint, unit tests, hygiene scans
pnpm run test:e2e   # Playwright over the real Electron app
```

Both must be green. CI runs the same two commands.

## The rules that are not negotiable

**The vault is the truth.** Everything under `.engram/` is derived and must be rebuildable from the markdown. Never make a feature depend on a cache surviving.

**Nothing is ever deleted.** Retiring a note is a `status` change. A wrong automated decision must cost one frontmatter line to undo, never a file.

**`updated` means the user edited it.** Recall stamps, warmth, link maintenance and every other automatic touch must leave `updated` alone — freshness badges, sweep deltas and the re-ask guard all read it.

**No LLM in a hot path.** Retrieval, ranking, association and grouping run on embeddings and plain math. The model writes sentences during background sweeps; it never sits between a keystroke and a result.

**`packages/core` never imports Electron.** Core is pure Node and fully unit-testable. If a feature needs the app shell, the logic goes in core and the wiring goes in `apps/desktop`.

**Files stay under 400 lines.** Add a module rather than growing one.

**Comments explain constraints, not history.** Write what the next reader must not break. No dates, no version numbers, no changelog prose.

## Working with prompts

The librarian's rulebook is `packages/core/src/agents-template.ts` and the per-job instructions live in `packages/core/src/jobs/`. Two things to keep in mind:

- Prompts are written in English, and they instruct the model to **write in the language of the source material**. Do not hardcode any output language.
- Several tests pin prompt content (the brief's shape, the contradiction rules). When you change an instruction, update the test in the same commit — that pairing is the contract.

## Reporting bugs

Include your OS, whether the semantic layer was on, and — if the librarian did something surprising — the job log from `workspace/_views/logs/`. Those logs record the exact prompt and the effects, which is usually the whole answer.
