# Performance review

The review covers renderer layout and streaming, browser previews and recordings,
startup imports, synchronous child processes, note polling and retrieval caches,
conversation persistence, routine loading, dependencies and packaging. Runtime
measurements use isolated local fixtures, not personal workspaces or provider calls.

## Measured changes

| Workload | Before | After |
| --- | ---: | ---: |
| Four idle native browser panes, surface measurements in 5 seconds | 760 | 25 |
| Last-message lookup from a 400-turn transcript, median of 15 reads | 41.30 ms | 21.76 ms |
| Append 25 turns to that transcript | 3,467 ms | 461 ms |
| Transcript bytes written by those appends | 33,627,700 | 1,465 |
| Main entry bundle before compression | 2,773,685 bytes | 1,399,819 bytes |

The storage fixture initially contains 1,389,490 bytes. Appends below the
compaction threshold avoid rewriting history; occasional atomic compaction still
costs a full rewrite. These are local measurements, not guarantees for every machine.
The entry-bundle reduction moves document generation into on-demand chunks; it does
not remove those capabilities or imply the same reduction in installer size.

## Changes and safeguards

- Native surfaces use resize/mutation/scroll events and a one-second heartbeat
  instead of unconditional frame-rate layout polling. Resize bursts coalesce.
- Transcripts append lines, serialize writes and archiving, compact atomically,
  and parse backwards only as far as the requested valid messages. Corrupt lines
  do not hide the previous valid message.
- Sorted note results are cached until file changes, with a defensive array copy.
- Note metadata scans run in bounded batches; MCP cache fingerprints include
  aliases, timestamps and sizes. Routine listings share concurrent reads but
  discard completed results so external writes appear on the next request.
- Document generators load only for document/presentation creation.
- Browser discovery and stale-process cleanup no longer execute blocking child
  commands on the main thread. Cleanup retains failed entries and existing PID
  identity guards. The synchronous quit-time cleanup is deliberately retained.
- Browser host shutdown does not wait for a stalled automation disconnect before
  sending EOF; its existing process-exit timeout remains in effect.
- Motion previews have bounded resolution and delivery rate; a lossless still
  restores text detail. Video frames travel as JPEG; still-image evidence stays PNG.
- Page actions do not wait for unrelated background network traffic; content
  readiness remains bounded and independently checked.
- Removed unused direct `chokidar` and `@types/diff` dependencies.

Rejected optimizations included dropping hidden-window chat tokens, omitting
routine login-wall checks, increasing embedding batch memory eightfold, and an
array-identity graph cache whose callers create fresh arrays. Unmeasured reductions
to recording and pointer responsiveness were also discarded.

## Reproduce

Run `pnpm --filter core exec tsx scripts/bench-transcripts.ts` for transcript
measurements. The comparison implements the previous read/parse/rewrite algorithm
beside the current implementation and checks that the final messages agree.

Run `pnpm --filter desktop build` followed by
`pnpm --filter desktop exec playwright test e2e/native-browser.spec.ts e2e/work-evidence.spec.ts`
on Windows for native layout, focus, popup, modal and recording checks. The native
test prints its five-second measurement. `native-surfaces.test.ts` separately pins
the heartbeat and event-coalescing behavior with a deterministic clock.

Full gates remain `pnpm run check` and `pnpm run test:e2e`. Actual provider latency,
third-party page scripts and large live embedding workloads are not simulated by
these fixtures; this review does not claim every possible freeze is eliminated.
