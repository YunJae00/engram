# Agent workspace delivery — 0.8.10

Scope: a conversational multi-provider coding workspace, not an IDE or a claim
of complete parity with another desktop product. Comets and Cosmos are retained.

## Changes

- Removed direct project editing/creation, language analysis and manual console,
  including renderer controls, preload/IPC entry points and background workers.
  Existing user files, recovery backups and externally running sessions are untouched.
- Added a persisted, editable next-turn queue. Restart/stop/configuration changes
  pause work; uncertain deliveries cannot be resumed automatically.
- Codex uses native `turn/steer` with the expected active turn ID. Claude exposes
  next-turn queueing, not an unverified same-turn equivalent.
- Guarded cancelled connection attempts by generation, ignored late completed-turn
  notifications and denied outstanding approvals when a turn ends.
- Added bounded task-start text baselines, including pre-existing uncommitted work.
  Hunk discard revalidates the preview and retains a recovery backup. Non-Git
  folders are supported. Added/deleted files remain read-only in the review.
- Preserved compact model/access/account controls, readable activity and delivery
  errors. Queue controls appear only when relevant; no IDE toolbars were added.

## Reproduced regressions

- A no-op queue drain could suppress the immediately following dispatch.
- A cancelled baseline capture could finish after a newer send and dispatch stale input.
- A late completed-turn start/delta could revive an already finished turn.
- Steering could target a newer turn if the original completed during persistence;
  the expected turn ID is now captured before saving and checked by the runtime.
- Empty file additions/deletions disappeared when comparison used text alone.
- A project could be hidden while its task was still capturing the starting files.
- A temporary Windows directory lock could fail an otherwise verified runtime install.

Tests cover those cases, queue ordering/restart/uncertain dispatch, approval
turn boundaries, preserved pre-task edits, stale diff rejection and excluded files.
Isolated Electron fixtures cover queue editing/steering, Stop, missed loading
updates, removed IDE entry points, accounts/history, tables and split layouts.

## Boundaries

Provider/network outages remain possible. Native permissions and extensions differ
by provider. No existing user session was taken over to validate this release.
Task baselines cannot distinguish another app's concurrent edits in the same folder.
Coverage is bounded (5,000 paths, 500 KB/file, approximately 20 MB total; plain-folder
traversal also caps visited entries). Large baseline reads/parsing have synchronous
cost; creation streams encoding per file. Snapshot failure blocks dispatch rather
than pretending rollback is available. No complete binary/rename rollback or
enterprise compliance certification is claimed.

Release gates: full checks, rebuilt Windows UI fixtures, package/version/feed,
semantic smoke, candidate CI and public release verification. Results are recorded
only after completion in release notes/task handoff.

Local verification: full check passed 1,750 unit and 18 timing tests plus typecheck,
lint and repository scans. Windows Developers/engine-settings/chat fixtures passed
30 tests. The added cancellation/archival guard passed the focused 13-test service
suite. Wide/narrow steering, split views and light/dark conversation screenshots
were inspected. Later packaging/publication results belong to the release record.
The final Developers fixture also passed all 11 tests with task-baseline review and
delivery-status layout assertions. The final steering guard passed 22 focused
adapter/service/outbox tests.
