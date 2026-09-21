# Developers

Switch between Chat and Developers with the two-icon toggle in the sidebar header. Developers is opt-in; ordinary
chats stay unchanged. Authentication stays in Settings → AI because the same
account also serves chats and filing. Session options opens those settings.
Developers is an agent workspace, not an IDE: there is no direct project editor,
language service or manual command console. Ask the agent to inspect, change and
test files; review its activity, approvals and changes in the conversation.

## Tasks and repositories

Add a local folder in the project sidebar, then use its + button to start a session.
Sessions are grouped under their project. Choose a model, reasoning effort and
access mode in the composer. Hover or focus the account ring for reported limits.
Use the top-bar layout controls for one, two or four independent panes. Switching
modes keeps selected sessions and drafts during the app session.

New tasks use the selected folder with review enabled. Git
worktrees require an existing commit. Automatic edits always use an isolated
worktree; a worktree separates changes but is not a security sandbox.

Tasks retain their provider session ID. Sending another message resumes an owned
task. Branch a conversation in the same folder, or explicitly create a separate
worktree at its current commit; uncommitted files are not copied to a worktree. Previous sessions opens
saved external transcripts, with up to 200 text messages, from the project's menu.
Codex previews read summary pages instead of hydrating the full tool history and
are capped at 500,000 text characters. Native resume keeps the original history;
the preview limit does not trim the provider session. Failed previews can be retried.
Resume session continues the original runtime conversation after you confirm it has
stopped in other apps. Create a branch keeps the original unchanged. Neither action
takes over a running external process; an absent live indicator is not proof of inactivity.
Include other folders shows the 100 most recently updated sessions across folders.
Continuing one adds its original working folder to the sidebar instead of changing its scope.

Between turns, choose a different provider in the same model menu to continue the
same Engram conversation and working folder. The new provider uses its selected
account and a fresh native session, with bounded prior conversation context; it
does not inherit the other provider's internal state or approval rules. A small
notice marks each switch. Current access restrictions remain in effect. Transfers
survive app restarts and are retained until the new provider completes a turn.
Long transcripts transfer their most recent 80,000 characters with an explicit
omission warning; files remain in place and the provider is instructed to inspect
their current state before editing.

Disabling Developers stops its runtimes, but keeps task history and files. Normal
chat use does not start a developer runtime. Stream updates are batched; only the
latest 100 items render initially, with earlier messages available on demand.

## Access and review

| Mode | Behavior |
| --- | --- |
| Review changes | Claude previews supported Edit/Write calls before approval. Codex uses its native read-only sandbox and approval requests. |
| Plan only | No write approval is granted. Codex may run commands inside its read-only sandbox; Claude permits supported local reads. |
| Automatic edits | Isolated worktree required. Supported Claude file edits may proceed automatically; other actions ask. Codex uses workspace-write with its native untrusted approval policy. |
| Full access | Explicit confirmation required for each new task. Commands and edits may run without an Engram approval prompt. |

Provider policies are not identical. Native runtime configuration and provider
rules still apply; this is not a claim that every shell command is intercepted.
Sensitive-path screening is additional protection, not a complete credential sandbox.

Codex approvals accept or reject the complete native request. They do not offer
pre-execution hunk selection. The Changes panel separately reviews completed text
edits and can discard a single hunk. It compares against a local snapshot before
this task's first message, preserving pre-existing uncommitted text. Changes made
later by other apps in the same folder cannot be attributed to a specific author.
A changed file invalidates an old review.
Original content is retained in a local recovery file before discarding anything.
New/deleted files are read-only in the review; ask the agent about restoring them.
Binary, sensitive, symlinked and oversized files are excluded. Snapshots cover up
to 5,000 paths, 500 KB per text file and approximately 20 MB total. Incomplete
coverage is labeled. An imported task gets its baseline before its next message,
not retroactively for earlier changes. Snapshot creation must succeed before sending.

Ask the selected agent to commit or prepare a pull request. Reviewing changes does
not silently push, publish or change Git's index.

## Follow-ups and interruption

While working, Enter queues a follow-up for the next turn. Up to ten messages can
be queued, edited or removed. Codex additionally supports Steer (Ctrl+Enter) for
the identified active turn. Claude uses next-turn delivery; no equivalent live
steering is claimed. Stop remains available during connection and dispatch.

Stopping, disabling, changing settings or restarting pauses queued work. A failed
or uncertain delivery is never automatically replayed. Review the conversation
and files before creating a new message when delivery was not confirmed. Paused
messages require an explicit Resume. Outstanding approvals are denied when their
turn ends rather than carried into another turn.

## Questions, skills and extensions

Structured questions appear in the conversation with choices and a free-text
answer. Permission requests show their details alongside Allow once and Deny.
Supported Claude edit approvals can remember an exact tool input and starting
content. Saved decisions can be removed in Settings → Developers.

Type `/` in an empty composer to load skills above the input, including before the
first message. Arrow keys select, Enter or Tab inserts, and Escape dismisses the list.
Selecting a skill inserts its native invocation; nothing runs until sending.
The available list depends on provider configuration and loaded skills.

Provider extensions are off by default. Settings → Developers can allow installed
hooks and project configuration only for new, explicitly confirmed full-access
tasks. These scripts and MCP servers can act outside Engram's approval UI. Their
configuration remains in the provider's native files, not a second copied store.
Account-level provider connections may still be available in other modes.

The separate external-connection controls let other AI clients use Engram; they do
not configure arbitrary MCP servers inside development runtimes. Coding-session
collection into Cosmos is independently opt-in.

## Usage

Task token counts and estimated API cost appear only when reported by the provider.
API cost is not a subscription bill. Account limits can be refreshed from the task
or Developers settings; unavailable values are labeled, never shown as zero.
Connected account limits preload without a development task. Provider events update
them immediately when available; visible windows also refresh once per minute.
No credit is purchased or usage reset by checking limits.

## Multiple accounts

Settings → AI → Accounts creates separately named subscription account profiles.
Each has its own native runtime configuration, sign-in and session history. The
System account retains the existing CLI sign-in; Engram never copies credentials.
The account button beside the composer model opens the same controls. Connect each
account once, then choose Use account without restarting or signing other accounts
out. This selection applies to new development tasks and the next ordinary chat turn.
Existing development sessions keep their original account, including while running,
unless you explicitly switch the session to another provider;
sessions from different accounts can run together. Automatic quota-based switching
is not supported. Provider limits and sign-in requirements still apply.

Previous sessions has an account selector; importing or resuming a session preserves
that account. Usage lists each connected account separately and refreshes on provider
events and once per minute while visible. When coding-session collection is enabled,
it checks registered profiles with the same private-folder exclusions and cursors.

## Verification

Branch a conversation in the same folder to share files, or explicitly choose a
separate worktree to isolate files at the current Git commit. Worktrees require
a Git repository with a commit; ordinary folders are never initialized automatically.
Disconnected turns are retained, not replayed. The next user message reconnects
using the saved native session. Active output is checkpointed at most once every
five seconds; an interrupted app restart marks unfinished activity as interrupted.

The normal checks include adapter, approval, cancellation, Git isolation and
conflict-aware hunk recovery tests. The Developers UI fixture checks opt-in,
settings grouping, narrow and split layouts, structured message rendering,
imported history, and task-scoped model controls that leave chat defaults unchanged.

Live provider checks are explicitly opt-in with `ENGRAM_DEV_LIVE=1`. They create
temporary folders under `tmp`, read a known value and resume the saved session.
Set `ENGRAM_DEV_CLAUDE_RUNTIME` to an existing installed runtimes directory for
the Claude fixture. Tests use the real provider account and can consume usage.
