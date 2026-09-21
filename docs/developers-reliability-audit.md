# Developers reliability audit

Baseline: 0.8.6 (`1c517c2`). Target: 0.8.7. Source audit and regression checks complete; publication requires the packaging and CI gates below.

## Reproduced findings

| Finding | Root fix | Regression evidence |
| --- | --- | --- |
| A timed-out skills lookup closes the shared Codex transport and interrupts a task. | Fail only the timed-out read request. Unknown/mutating requests retain transport shutdown on timeout because their outcome is uncertain. | `dev-rpc.test.ts`: failed before the fix; now verifies notifications and subsequent turn requests survive, with late replies ignored. |
| Stop is disabled while an existing task's send/connection request is pending. | Give cancellation its own pending state; do not route it through the send gate. | `developers.spec.ts`: isolated IPC fixture reproduced the disabled Stop button; rebuilt Windows suite passed all 8 tests, including cancellation while connecting. |
| A stopped send can reach the runtime after its pending history save completes. | Recheck runtime identity, stopping and failure after the save, before dispatch. | `dev-service.test.ts`: deferred-save fixture failed before the fix; now confirms no dispatch after Stop. |
| One cleanup error lets stop-all return before other tasks finish cleanup and persistence. | Settle every stop before propagating an error. | Deferred second task fixture failed before the fix and now waits for its saved history. |
| New turns can start while disabling Developers waits for existing tasks to stop. | Apply the disabled preference before cleanup and persist it even if cleanup fails. | Fixture rejects new sends during shutdown and verifies the disabled preference survives a cleanup error/reload. |
| A burst of queued saves serializes and writes the same whole history repeatedly. | Coalesce not-yet-started saves into one latest-state snapshot; retain ordered atomic writes and failure recovery. | 20-save fixture failed with 20 history reads, now uses one and restores the latest model/history. |
| A branch can inherit a different provider/runtime if settings change while its folder is prepared. | Reuse the per-session settings guard for branching; release it on success or failure. | Deferred-folder fixture failed before the fix; now rejects concurrent settings, send and branch requests and retains the source identity/history. |
| Live messages received during initial conversation loading are dropped. | Subscribe before loading and merge buffered updates into the snapshot before showing it. | Windows fixture failed before the fix with a missing completion message; latest rebuilt Developers E2E passed all 9 tests. |

Full repository check passed: typecheck, lint, 1,733 unit tests, 18 timing tests and TODO/CSS scans. Latest rebuilt Windows Developers E2E passed all 9 tests, including both new UI regressions, split drafts, narrow layout and reduced motion. The service suite includes 10 tests. No real account, external running session or user app was used for these reproductions.

Synthetic snapshot measurement (five samples, no private history): 100 sessions / 2.08 MB took 5.28 ms median (25.80 ms maximum); 1,000 sessions / 20.85 MB took 143.89 ms median (240.47 ms maximum). Coalescing reduces repeated queued work, not the cost of one snapshot. These local timings are not performance guarantees.

## Release gates and limitations

- Large-history snapshots remain synchronous and proportional to retained history. Consider per-session persistence only with a separate measured migration plan; no format migration is included here.
- Packaging/semantic smoke, candidate CI (including full Windows E2E), and public release/feed verification must pass before publication is reported complete.

## Additional review evidence

- Reviewed Codex/Claude permission handling, cancellation, question validation, read-only probes and account-scoped usage refresh. Unsupported approval requests fail closed; probes own their transports; usage refresh is bounded to two accounts concurrently.
- Reviewed Git worktree preflight, selected-file commits and hunk-review fingerprint/backup protections. External editors can still modify shared files; worktrees are not a security sandbox.
- Reviewed native history bounds, resume/fork identity and split-pane draft keys. The user must stop an external live session before resuming it; the app does not take it over.
- Inspected the configured main-log location without reading credentials or message contents. No log existed at the standard `%APPDATA%/Engram/logs/engram-main.log` location; no production-log diagnosis is claimed.
- Visually reviewed isolated light/dark task screenshots, the corrected 600px narrow workspace, wide/narrow split panes and the history dialog: heading/composer centering, toolbar alignment and contained layout are intact. Narrow capture originally showed the navigation overlay, so the fixture now closes it before capture. Split panes and reduced-motion behavior passed the Windows suite.

## Safety boundaries

No automatic replay after disconnect. A provider switch transfers bounded visible history, not native hidden state. Network/provider outages remain possible. A passing isolated regression does not establish production-wide fault freedom.
