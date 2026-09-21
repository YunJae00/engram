# Developers workspace delivery

Historical 0.8.8 delivery record. Direct IDE features described below are removed
in 0.8.10; see [the agent-workspace delivery](developers-agent-workspace.md).

Scope: the requested developer workspace release after 0.8.7. This is a delivery checklist, not a claim of feature parity. Preserve ordinary chat and filing, account credentials and external running sessions. No automatic replay of possibly executed commands.

## Delivery gates

- [x] Conversation rendering: tables, nested lists, quotes, links, fenced code, streaming and reopened histories. Safe HTML handling and narrow-pane overflow.
- [x] Compact composer: one action row, visible permissions/model/send, secondary settings and usage in options; keyboard, focus and reduced-motion handling.
- [x] Native capabilities: map actual Codex and Claude support for project instructions/settings, MCP, skills, models/effort, approvals/questions, resume and branch. Show differences explicitly, do not silently widen permissions.
- [x] Project files: browse, search, open, edit, save with external-change conflict protection; attach file or selected code as context with bounded reads and workspace containment.
- [x] Commands: inspect real command/output/status, execute explicitly confirmed user commands, cancel owned processes and preserve bounded local logs. Users must not put secrets into logged commands.
- [x] Changes: review tracked/untracked diffs, safe text-hunk revert, staging and selected-path commits. Identity-changing reverts remain explicit Git operations.
- [x] Editor: JavaScript/TypeScript completion, definition navigation and diagnostics using the installed compiler; document language/runtime requirements rather than claiming universal support.
- [x] Lifecycle: start, stream, approval/question wait, cancel, disconnect, restart, account/provider switch, concurrent panes/drafts and large histories with isolated fixtures.
- [ ] Visual review: light/dark, wide/narrow/split, dialogs, empty/error/loading states, keyboard and reduced motion.
- [ ] Release: full checks, E2E, packaged smoke/version/feed, candidate CI, publication and public download/feed verification.

## Verified findings and work in progress

- Developers used the small digest Markdown renderer, which did not implement tables or ordered lists. Replaced hand-written block parsing with the installed marked lexer and React element rendering; HTML remains escaped and images are not fetched. Focused safe-rendering tests pass. Shared digest caller also uses this renderer and needs regression coverage.
- Composer exposed settings and usage on a second row alongside redundant folder context. Consolidated into session options with a single toolbar; access stays visible and the header retains project context. Geometry and focused E2E assertions pass.

Version 0.8.8 release criteria: full checks, Windows E2E, packaged smoke and public asset verification. A source candidate is not a published release.

## Implementation checkpoint

- Added requested reading-width alignment: Developers and Comets now share the same gutter variables, 740 px reading measure and 820 px composer measure. Reading text remains inset relative to the composer on narrow panes; tables/code scroll internally. Rebuilt E2E geometry assertions and light/dark/narrow visual checks passed.

- Project files now have a bounded, workspace-scoped directory browser and CodeMirror text editor, per-file drafts, file/selection attachment, conflict fingerprints and recovery backups. Saves are blocked while any known task in the same directory is active. File saves, hunk undo and commits share a workspace mutation gate. Symlink escapes, sensitive paths, binary/non-UTF-8 files and files over 500 KB are refused. External programs do not participate in Engram's lock; revalidation narrows but cannot eliminate a cross-process race immediately before replacement.
- File tests cover stale writes, backup contents, traversal/junction escape, binary/encoding/size checks, disabled workspaces and task locks. A Windows UI test verifies editing, saving, external changes, draft recovery and attachment; 10 Developers E2E tests passed before the latest small follow-ups.
- History serialization retains the existing JSON format but writes bounded chunks from a captured snapshot. Four store tests pass, including large Unicode history round-trip and an assertion that encoding never stringifies the entire history at once. This reduces individual event-loop stalls, not total history storage or linear snapshot-copy cost.
- Claude coding adapter was missing `systemPrompt: { type: 'preset', preset: 'claude_code' }`. Added the official preset and bounded root CLAUDE.md text guidance for restricted configurations, without enabling executable project hooks/settings. Five adapter tests plus one instruction reader test pass. Existing resumed native sessions may retain their original prompt until native context reconstruction.
- Session options explain effective runtime and extension restrictions, native session identity and provider handoff limitations. This is not a claim that every provider feature is exposed yet.
- Web links in developer answers use an explicit native confirmation before opening the default browser; no renderer navigation or global protocol-policy relaxation.

Official Claude reference: https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts (coding preset versus minimal SDK default; settings sources separately govern native CLAUDE.md loading).

The following delivery pass adds bounded project-wide literal search, exclusive new-file creation, a real confirmed non-interactive command console with owned-process cancellation and local logs, selected-path staging/unstaging, rename/deletion previews, and JavaScript/TypeScript language services. Text editing remains available for other languages. This does not claim complete IDE, debugger, extension-marketplace or all-language parity.

## Native capability map

| Capability | Codex | Claude |
| --- | --- | --- |
| Coding runtime | Native app-server with runtime-managed instructions | Agent SDK with native claude_code prompt preset |
| Project instructions | Runtime AGENTS/config handling subject to project trust | Restricted modes read root CLAUDE.md and .claude/CLAUDE.md as bounded text; full-access extensions use native user/project/local settings |
| MCP/hooks | Native account config may apply; untrusted project and hooks/notify restrictions remain | Native settings/MCP enabled only by explicit full-access project-extension configuration |
| Skills | Native skills/list with slash discovery | Native supportedCommands with slash discovery |
| Models/effort | Thread model and turn effort | SDK model and effort |
| Approvals/questions | Native file/command approvals and structured questions; unsupported requests fail closed | Permission hooks and canUseTool, edit previews and structured questions |
| History | Paginated preview, native resume/fork with excludeTurns | Bounded preview and SDK resume/fork |
| Account/provider switch | Existing sessions stay account-bound; cross-provider visible-history handoff starts a new runtime | Same boundary; no hidden state transferred |

Official protocol reference: https://developers.openai.com/codex/app-server. Compared with the pinned runtime schema and adapter tests. MCP result content is shown as text, not executed as UI; unsupported elicitation/dynamic permission shapes remain denied. Native configuration management remains through the providers' own configuration, not a new credential editor.

## Workspace safety and limits

- Editor uses UTF-8 files up to 500 KB, recovery backups, retained draft fingerprints and a workspace mutation gate. Drafts persist in local browser storage, not synced storage. External programs can still race a file replacement; no cross-process lock is claimed.
- Search visits at most 2,000 entries/20 MB of readable text and returns at most 100 results; generated, sensitive, binary and large files are excluded. New files are created exclusively in existing directories without overwriting.
- Console requires native confirmation for every run, shows the actual working folder, retains the last 200,000 output characters and saves completed output locally. Closing a panel does not cancel its command. Commands cannot overlap known Engram mutations/tasks in the same folder, and shutdown stops commands before waiting for pending writes.
- Language analysis runs in a bounded worker using the already-installed TypeScript version, now included in runtime packaging. It reads bounded in-project dependencies and TypeScript libraries, ignores executable language-service plugins, and has a 20-second timeout. Cross-project dependencies and other languages may require native build tools.
- Staging validates a fresh Git snapshot; external Git processes do not share the in-app gate. Rename/delete diffs are viewable, but identity-changing revert remains an explicit Git command rather than an unsafe hunk action.
- History writes retain the existing format and encode bounded item chunks. Snapshot copying and very large individual items still have nonzero synchronous cost.

Release publication requires the full-test, packaging and public-verification gates below.

## Latest verification

- Full check completed: 1738 unit tests and 18 timing tests passed, plus typecheck/lint and scans. Some follow-up source/test edits landed during that run, so this is not the final release gate for the eventual candidate.
- Latest focused suite: 26 tests across files, instruction reading, Claude adapter, service, store and safe Markdown passed after the follow-ups.
- Developers Windows E2E: 10 passed on the prior rebuilt snapshot. After shared reading-width changes, rebuilt focused welcome/structured-output scenarios both passed, including the 740 px maximum measure and composer inset assertions at wide and 950 px widths.
- Visually inspected light/dark task, compact composer, file-conflict editor and narrow reading screenshots. Added list indentation and file-panel reduced-motion-aware transition afterward; CSS scan and diff whitespace check passed. Final rebuild should include these last CSS changes.
- The subsequent workspace pass passed 11 rebuilt Windows Developers E2E scenarios, including real language-worker completion/diagnostics, editor conflicts, search/create, explicit command cancellation and retained console output. Additional file, console, language, service, Git, Codex-event and process tests passed. Full checks and 145 screen tests are running for 0.8.8; packaging/publication remain pending. Existing completed-release automation remains paused and is not used for this release.
- Full release check passed: 1,743 unit tests, 18 timing tests, typecheck, lint and scans. Final follow-up typecheck and scoped lint also passed. The complete Windows screen run remains in progress; a hidden auxiliary-window startup timed out once and passed in its fresh-worker retry. No product change was made for that non-reproduced fixture failure. Final rebuilt workspace checks and packaged checks remain required before tagging.
