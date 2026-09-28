# Conversation completion and browser continuity (0.8.19)

## Evidence and root causes

- `ipc.ts` publishes `chat:done` before post-answer memory extraction resolves.
  The task runner still owns the channel, and may also schedule verification.
  The renderer previously treated that per-turn answer as task completion.
  Thus the UI offered Send while the backend correctly rejected concurrent work.
- The progress label retained the last tool-start event after its observation
  returned. `Thinking` counted time since the response began, not that tool.
  A label such as “Reading the page / 703s” does not establish a 703-second read.
- Read-only inspection of local timing/audit metadata found browser reads
  completing in milliseconds/seconds, and a separate 705-second run with 52
  tool calls (~123 seconds inside tools, ~561 seconds between calls). That run
  was NOT the same audited conversation as the reported portal request and
  must not be presented as its exact trace. No matching saved follow-up text
  was found. The precise split of the reported 703 seconds remains unknown.
- Browser shutdown clears live lane handles. The next turn formerly received
  no browser context and `read_open_page` could create/read a blank tab. Local
  logs also confirm a memory-pressure shutdown (1.5 GB free); the available
  evidence does not tie that shutdown to the reported request.
- Idle closure was armed by browser operations without holding it throughout
  the model turn. Memory-pressure closure remains necessary even with a hold.

## Fixes

- A task-wide working event tracks the actual channel lock through finalization
  and verification; Send/Stop and reload recovery follow that lifecycle.
  Errors are delivered before releasing the UI. Concurrent actions remain blocked.
- Tool completion explicitly changes the UI back to model thinking without
  deleting the activity record. The timer is labeled total response time.
  Timing logs now include the conversation channel and send/release timing,
  without message text, addresses or tool arguments, to correlate future delays.
- Active turns hold the existing idle-close mechanism. Closed lanes retain
  their last address in memory, separately per conversation; an explicit reset
  forgets it. Continuations receive a reopen/reobserve instruction. Reading a
  missing previous page fails explicitly rather than fabricating a blank result.
  Navigation still goes through `open_page`; no prior clicks or submissions are
  replayed, and a closed browser is not automatically replaced by computer use.
- A 45-second read deadline is defense in depth, not a proven explanation of
  the reported delay. Cancellation propagates to frame reading so a late read
  cannot replace newer control references. Completed frame timers are cleared.
  Unreadable frames now mark the extract incomplete instead of disappearing
  silently; this is not evidence that any particular reported field was missed.

## Validation and limits

Regression coverage includes task lock continuity, pending verification,
unattended/reloaded conversation state, model-vs-tool progress, canceled and
hung reads, late frame results, per-lane address isolation and explicit reset.
Electron fixtures exercise composer locking, phase changes and approvals.
Release verification results are recorded in the release notes.

No corporate website was opened, submitted to, or modified. No live model
benchmark was run. Browser continuity is in-memory, not crash/session-history
restoration; unsaved forms may be lost and fresh login may be needed. The model
still decides navigation and may be slow. These changes do not prove that every
activity/remark in the reported Time Report has been read correctly.
