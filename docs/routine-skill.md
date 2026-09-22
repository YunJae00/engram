# Explicit routine learning

In a Comet, send `/routine` (or choose it after typing `/`). Work in that chat, then choose **Finish**. Review the name and standalone instructions before saving. `/routine finish` and `/routine cancel` provide the same explicit controls.

- Nothing is collected for a routine before activation or from another chat. Existing Cosmos memory is unchanged.
- Automatic keep and recurring-schedule suggestions no longer run after chat responses. Saved routines, schedules and execution approvals remain intact.
- Drafts survive reopening the chat. They live in the vault's private directory, outside the engine's working directory and Git backup. Only sanitized requests and bounded navigation hints are collected, not raw page responses or typing payloads.
- Finishing organizes an editable draft using the selected chat provider with tools disabled. Provider failure leaves manual editing available. Saving never starts a run or creates a schedule.
- Failed/interrupted turns are marked incomplete; their actions do not become a verified method. Capture stops visibly at 20 turns or navigation-size limits, rather than silently implying the complete history was kept.
- A saved routine is reusable guidance, not a recording of native runtime state or permission to repeat a write. Each run observes current state and asks for required inputs and approvals.

Regression coverage includes conversation isolation, late-turn rejection after discard, ordered concurrent updates, persistence, capture limits, provider failure, review-before-save, idempotent save recovery, and isolated Electron start/reopen/review/save/discard flows. No real accounts or user sessions are needed by these fixtures.
