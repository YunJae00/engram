# Bounded browser acceleration

Browser observations remain fresh. Acceleration changes what is transmitted or
how known reads are grouped, not the authority to act.

## Observation delivery

Tool sessions may transmit a body delta after a successful browser action. The
stored step retains the full report. Current control labels and numbers are
always transmitted. A tab or document change, unknown identity, explicit read,
intervening non-page tool, dialog, fault, large extract, or three consecutive
deltas restores a full report. A model missing the named base must request
`read_open_page`; a delta is not independent evidence of task completion.

Control numbers refer to a reading, not a persistent selector. Before resolving a
number, the browser checks the original element identity, label, role and state.
A replaced element, changed numbering or frame navigation requires a fresh read.

## Known page reads

`read_pages` reads at most four explicit HTTP(S) addresses in order. Each page
requires a positive literal readiness check. All requests are validated before
navigation. Redirects, login walls, dialogs, faults, missing readiness, errors and
cancellation stop the batch. Earlier observations are retained. There are no
clicks, form inputs, automatic retries or background executions in this tool.
Each page consumes one unit of the existing session budget.

Only use addresses in the current request's scope. Navigating a URL is not a
general guarantee that a remote server has no side effects; this tool does not
grant permission to invoke mutation endpoints. Readiness checks establish only
the observed state, not complete records or the success of the user's task.

## Skills

The initial index contains at most five topic-matched skills. `find_skills` can
retrieve another shortlist without loading all bodies. Stale sources are ranked
lower. Fresh matching verification receipts are tracked separately from use
counts; neither is proof that a skill is correct or caused success. Interrupted,
approval-blocked and incomplete turns earn no credit. User edits remain protected.
Saved tasks continue to resolve current dates and inputs and never inherit old
approvals. No new automatic skill execution or credential handling is introduced.

## Measurements and fallback

`harness` log entries contain durations, operation names and character counts,
not page text, URLs or input values. Browser reads/actions, tool execution, turn
duration and transmitted observation size are separate. `session-overhead`
includes runtime/model waiting outside tools; it is not a provider token/cost
measurement. A batch's completed count means passed readiness checks only.

Set `ENGRAM_COMPACT_OBSERVATIONS=0` or `ENGRAM_BATCH_READS=0` before launching to
disable the respective optimization without deleting data. Single-step engines
retain full observations. Compare identical fixture outcomes and actual browser
reads as well as delivery size; fixture improvements are not live-site guarantees.

Checks: `packages/core/test/harness-optimization.test.ts`,
`packages/core/test/skill-feedback.test.ts`, and
`apps/desktop/e2e/page-hands.spec.ts`. The browser fixture logs full/sent character
counts and compares batch results against individual reads without live accounts.
