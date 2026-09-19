# Developers

Developers is an opt-in workspace, separate from ordinary chats. Open it from
the workspace menu or Settings → Developers. Authentication stays in Settings →
AI because the same account also serves chats and filing.

## Tasks and repositories

Choose a local folder, provider, model, reasoning effort and access mode. Git
worktrees require an existing commit. Automatic edits always use an isolated
worktree; a worktree separates changes but is not a security sandbox.

Tasks retain their provider session ID. Sending another message resumes an owned
task. Branch task creates a new worktree at the source task's current commit and
forks its conversation; uncommitted files are not copied. Previous sessions opens
saved external transcripts, with up to 200 text messages. Branching never takes
over a running external process. An absent live indicator is not proof of inactivity.

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
edits and can discard a single hunk. It compares against the current commit, so
changes may include the user's own work. A changed file invalidates an old review.
Original content is retained in a local recovery file before discarding anything.
Renames, deletions, binary files and oversized diffs require review in an editor.

Commit selected files leaves unrelated staged paths alone. Git hooks are disabled
for these panel operations. Ask to prepare a pull request drafts a request for
the selected coding agent; it does not silently push or publish a pull request.

## Questions, skills and extensions

Structured questions appear in the conversation with choices and a free-text
answer. Permission requests show their details alongside Allow once and Deny.
Supported Claude edit approvals can remember an exact tool input and starting
content. Saved decisions can be removed in Settings → Developers.

After connecting a task, Skills loads commands reported by that runtime. Selecting
one inserts its native invocation into the composer; nothing runs until sending.
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
Claude account limits require a connected development task and a supporting SDK.
No credit is purchased or usage reset by checking limits.

## Verification

The normal checks include adapter, approval, cancellation, Git isolation and
conflict-aware hunk recovery tests. The Developers UI fixture checks opt-in,
settings grouping, narrow layout and structured message rendering.

Live provider checks are explicitly opt-in with `ENGRAM_DEV_LIVE=1`. They create
temporary folders under `tmp`, read a known value and resume the saved session.
Set `ENGRAM_DEV_CLAUDE_RUNTIME` to an existing installed runtimes directory for
the Claude fixture. Tests use the real provider account and can consume usage.
