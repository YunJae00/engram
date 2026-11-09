# Batching analysis (2026-11-09)

Source: the live clone's `orchestration/decisions.tsv` (batch `20261108T065626`, 2026-11-08 06:56 → 2026-11-09 11:29 UTC,
224 items, 313 attempts), `ledger.json`, and `tmp/run-mac-*.log`. Durations are the gaps between the runner's own
timestamped decisions (launch → finished / implemented / verdict). Host: 8 GB M2, swap 3-4 GB, load ~10-17.

## Wall time per step (minutes)

| step | n | median | p90 | total |
|---|---|---|---|---|
| design phase wall (designing → pick) | 98 | 18.9 | 32.4 | 2207 |
| implement (launch → report passes machine checks) | 241 | 7.2 | 15.7 | 1994 |
| verify phase wall (verifying → attempt fail) | 205 | 5.4 | 9.6 | 1273 |
| tests lane: runner `check:quick` + criteria (blocks the tick) | 255 | 2.3 | 5.0 | 833 |
| verify break reviewer | 243 | 2.4 | 4.0 | 645 |
| verify spec reviewer | 244 | 2.1 | 3.6 | 543 |
| implement → invalid (wasted session) | 55 | 7.8 | 15.8 | 445 |
| verify tests reviewer | 255 | 1.2 | 3.3 | 443 |
| designer claude-local | 98 | 3.5 | 6.3 | 373 |
| verify phase wall (verifying → attempt pass) | 48 | 5.2 | 7.6 | 311 |
| designer codex-local | 99 | 3.0 | 3.9 | 299 |
| verify desktop reviewer | 20 | 1.7 | 3.0 | 35 |
| merge (verified → merged) | 48 | 0.1 | 0.6 | 13 |
| integration (passed) | 2 | 6.4 | 6.4 | 10 |

Not measurable from what survives: the split of `check:quick` into typecheck / lint / vitest. `scripts/check-quick.mjs`
prints per-step seconds, but those logs live in verifier worktrees that are dropped after each verdict, and
`run-mac-*.log` / integration logs carry no timestamps. Integration ran 3 times in the whole batch, so the
integration-tier checks (typecheck, lint, full vitest, build) are not a sink; the per-item `check:quick` is.

## Top time sinks

1. **Design deadline idling.** Both designers finish in ~6.5 min (3.5 + 3.0, run one after another for slots), but the
   runner only auto-picks once the 15-minute deadline passes: median 18.9 min per hard item, ~12 min of it idle.
   130 of 223 items were hard (every bounce makes an item hard), so this is the largest total.
2. **One implementer session per item.** 7.2 min median, and each holds one of the 3 local slots and ~0.5-1 GB on an
   8 GB host. 55 sessions (445 min) ended `invalid`.
3. **Per-item `check:quick` in the runner.** 2.3 min median, run synchronously inside the tick, so items queue behind
   each other's typecheck + lint + related vitest.
4. Reviewers (spec/break/tests) are 1-2.5 min each and already run in parallel and uncounted; not batched here.

## What `--batch` changes (opt-in; default behaviour unchanged)

`node orchestration/run.mjs run --quick --batch` (size 3) or `--batch 2..4`, or `ORCH_BATCH=3`.

- **Grouped implementer session** (`lib/batch.mjs` `pickBatches`, `phase-implement.mjs` `startBatch`): 2-4 briefed
  items that are easy, on their first attempt, in the same area and rung, with disjoint `allowedFiles`, run in one
  `claude-local` session (one slot, deadline `implement × (n+1)/2`, e.g. 80 min for 3). Each item still gets its own
  branch, worktree, report, attempt and verdicts, so the ledger schema and per-item states are unchanged; merge is
  still one squash commit per item.
- **Shared `check:quick`** (`sharedCheck`): when the tests lane starts for a batched item, the runner merges every
  implemented member onto the base in one throwaway worktree and runs `check:quick` once; members covered by a
  passing run skip their own (their criteria still run on their own tree). Conflict or failure → each member runs
  its own check as before.
- **Early design pick**: with `--batch`, a hard item's design is picked as soon as both designs exist (same
  earliest-wins rule) instead of waiting out the deadline.
- **Split on failure**: a failed batch launch puts every member back on the single path in the same tick; a member
  that fails, times out or is invalid bounces alone, and its next attempt is always single (bounced = hard).
  The shared session is killed only after every member has an outcome.
- `node_modules` were already shared across worktrees (`linkNodeModules`) and the desktop build is already cached
  per tree (`build-cache.mjs`); nothing to add there.

## Expected speedup (estimate, not yet measured on a live batch)

- Hard items: design phase 18.9 → ~6.5 min median, about -12 min per hard item (~-1200 min over this batch's 98
  design phases).
- Easy items, per group of 3: two fewer Claude processes and slots; `check:quick` in the tick 3 × 2.3 → ~2.5 min
  (about -4.5 min of serialized runner time). The implementer session itself is serial inside the batch, so it saves
  wall time only when slots are the bottleneck (they are on this host: 3 slots shared with designers and verifiers).
- Not batched: hard items, bounced items, cloud implementers, reviewers.
