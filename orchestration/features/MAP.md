# Feature Map

How to reach each major surface of the desktop app, and which `verify-cli` scenario proves it. A row is grounded in the test ids the renderer actually renders. The command is the proof; this file only says where to look.

Run from the repo root:

```
node scripts/verify-cli.mjs --list
node scripts/verify-cli.mjs <scenario>          # builds when apps/desktop/out/main/index.js is missing, then uses it
node scripts/verify-cli.mjs <scenario> --build  # rebuilds desktop even when that file exists
```

`verify-cli` launches that build on a fresh vault (`ENGRAM_ENGINE=none`, git and autotidy off, window hidden) with three notes: `n-hello-0001` ("Hello note", happened 2026-01-15), `n-argo-0001` (2026-02-15), `n-argo-0002` (2026-03-15, derived from the first Argo note). It waits until `shell` is visible, then calls the scenario's `run(page, { app, paths, expect, openActivity, log })`. `openActivity` is `apps/desktop/e2e/navigation.ts`. The process prints one JSON line and exits 0 only when `ok` is true. A per-item criterion and the desktop verifier run the command without `--build`; the first run in a fresh worktree builds, and later scenarios in that same checkout reuse `apps/desktop/out/main/index.js`.

A new scenario is a file `scripts/verify-scenarios/<name>.mjs` exporting that `run`. It returns `{ ok, evidence }`. Add its row here in the same change. The Conductor has a verifier add it; an implementer does not (`orchestration/CONDUCTOR.md`).

| Surface | How to reach it | Scenario | What the scenario asserts |
| --- | --- | --- | --- |
| Shell / boot | Launch. Home is Comets. | `boot` | `shell`, `topbar`, `bots-view` (`App.tsx`, `TopBar.tsx`, `BotsView.tsx`) |
| List / timeline | Engram menu → Library, or `openActivity(page, 'list')` → `activity-list` | `list-filter` | `list-view` shows 3 `list-row`s; `.list-date` is newest-first across the three distinct `happened_at` days (`chronoDate` in `ListView.tsx` is `happened_at` or `updated`); filter "Hello" leaves 1; the row opens `note-sheet` |
| Note open | Cosmos star, or the list row | `note-open` | `openActivity(page, 'sky')`, collapse `cosmos-chat-collapse`, click `[data-node-id="n-hello-0001"]`, `note-sheet` contains "The very first note", Escape closes it |
| Palette | Ctrl/Cmd+P | `palette` | `palette-input` query "Hello" opens `note-editor` / `cm-host` |
| Cosmos | Engram menu → Cosmos, or `openActivity(page, 'sky')` → `activity-sky` | `cosmos` | `sky-view`, `brain-graph` (`SkyCanvas.tsx`), `cosmos-chat`; collapse, then `cosmos-chat-open` restores `cosmos-chat-input` |
| Mission control / panels | On Comets, the top-bar split (`mission-layout-4`), or `openActivity(page, 'mission')` | `mission` | `mission-control` with `mission-tile-0` and `mission-tile-3`; `mission-add-0` opens `mission-add-menu`; Escape closes it |
| Comets | Home, or Ctrl/Cmd+L | `comets` | `bots-view`, `comet-welcome`, `welcome-input`; `cosmos-chat` is absent on this tab |
| Bot v1 reset | Launch, fully close, seed v1 `.engram` (unversioned `bots.json`, 2 scheduled tasks, chats, memory, `_person.json`), then relaunch and close twice in sequence on the same vault and userData | `bots-reset` | Sidebar lists only `Engram`; one byte-identical `backups/bots-v1-*` folder; `bot-memory/_person.json` kept; `notices.json` holds one notice whose text has the backup path and 2 stopped schedules; second relaunch adds no backup or notice. Returns ok:false until rd-bots-reset-v2 lands |
| Bots sidebar | Comets sidebar after seeding six bots through `window.engram` (two sections, a pin, a label, a hidden bot, a recent and a 72h-old transcript) and a reload, UI language `en` | `bots-sidebar` | C1-C14: Engram hero with 64px avatar outside the tree; role=tree/treeitem rows with name, label and last message and the time only in a title tooltip; pinned, sections, loose, old and `Hidden bots (n)` order; hidden group toggle; no `sidebar-earlier`; ArrowDown/ArrowUp, F2, Shift+F10 on rows; search by label, purpose, message and name; Hide from sidebar, Move to Section A and Make primary read back through `botsList` and `sidebarLayout`; named status dots. Returns ok:false until rd-sidebar-bots, rd-sidebar-context-menu and rd-a11y-sidebar-keys land |
| Bot info pane | Comets, open a bot, click the title pill `bots-title-pill`; one bot `Info Bot` seeded through `window.engram` and a reload, UI language `en` | `bot-info-pane` | P1-P6: chat opens with the pill showing the name and `bots-input`; the pill opens `bot-info-pane` 320px on the right edge of `bots-view` beside `bots-thread`; one tablist holding Overview, Routines, Files, Computer and Past chats tabs with linked panels (aria-selected, aria-controls); empty tabs have one 13px line and one button; Escape closes and focus returns to `bots-input`; the title pill toggles the pane. Returns ok:false until rd-info-pane-shell lands |
| Bot create | Sidebar + (`sidebar-create`) → `bots-new`, or Cmd/Ctrl+N; nothing seeded, UI language `en` | `bot-create` | N1-N6: `create-bot-dialog` with name, label, template, first task and a 96px avatar preview; an empty or blank name creates nothing; Create adds exactly one bot, opens its chat with `bots-input` focused and keeps the previewed character; Cmd/Ctrl+N opens it from nothing focused and from the composer; the Photo tab of `avatar-picker` stores a PNG as the bot's avatar under `bot-avatars`. Returns ok:false until rd-create-bot-dialog, rd-create-shortcut and rd-avatar-picker land |
| Bot fresh start | Open a bot's chat, Start over (`bots-fresh`) → confirm (`bots-fresh-confirm-ok`), then the title pill `bots-title-pill` → Past chats; one bot `Fresh Bot` created through `window.engram` with four turns and one memory fact written under `bot-chats`/`bot-memory` and a reload, UI language `en` | `bot-fresh-start` | F1-F7: the chat shows the four seeded turns; Start over shows `bots-fresh-confirm` before anything is archived; confirming empties the live chat; exactly one byte-identical archive is on disk and listed by botConversations; Past chats in `bot-info-pane` lists it (`bot-past-item`) and opens it read-only (`bot-past-view`, no composer); its bubbles have the same computed style as the live ones; the memory fact is kept on disk, in botMemory and in Overview. Returns ok:false until rd-fresh-start-ui and rd-info-past-tab land |
| Korean UI | settingsSet uiLanguage `ko` and a reload; the sidebar `app-sidebar` and its + menu (`sidebar-create` → `.sidebar-create-menu`), the primary bot's chat (`bots-view`) and its title pill `bots-title-pill` → all five `bot-info-pane` tabs, + → `bots-new` → `create-bot-dialog`, `activity-settings` → `settings-view`; then uiLanguage `en` and a reload; `UI_KOREAN_REGIONS` limits the regions | `ui-korean` | ko-applied, ko-sidebar, ko-chat, ko-info, ko-create, ko-settings, en-restored: no visible text or aria-label/title/placeholder/alt with 3+ ASCII letters outside the allowlist, user-authored names and notes, URLs and paths; English sidebar after switching back. Returns ok:false until rd-i18n-sidebar, rd-i18n-bot-surfaces and rd-i18n-settings land |
| Brain (AI connection) | `connect-banner` → "AI settings" when no engine is connected | `brain` | Banner opens `settings-view` on `settings-nav-ai`; `brain-claude-status` and `brain-codex-status` (`EngineSettings.tsx`) |
| Capture | Second window, not a shell route. Preload `showQuickComet` → `quick:show` → `#quick` | `capture` | `quick-capture` and `quick-input`; Escape hides the window |
| Inbox (scrap pile) | Ctrl/Cmd+Shift+P, command "Open scrap pile (inbox)" | `inbox` | `inbox-overlay` / `inbox-list` shows the empty copy; Escape closes it |
| Settings | Sidebar `activity-settings`, or `openActivity(page, 'settings')` | `settings` | `settings-view`, About via `settings-nav-help` / `help-panel`, `settings-export-logs`; Escape closes it |
| Conversation activity | Open a saved comet, then send a message through `bots-input` | `ui-activity-status` | Persisted tool work stays hidden and conversation text survives; one inline `role="status"` evolves on `comet:step`, clears on `chat:done` and reload, and respects reduced motion |
| Conversation status line | Open a saved comet, then send a message through `bots-input` while `chat:send` is held | `ui-status-line` | While pending, the `role="status"` / `bots-thinking` line sits outside message bubbles with no bubble background, radius or padding container, at wide and narrow widths, in light and dark themes |
| Interaction motion | Sidebar create/folder menus, conversation navigation and delete dialog | `ui-interaction-motion` | Compositor motion, reduced motion, focus and dismissal, mutation failure recovery, rapid navigation and reload (`scripts/verify-scenarios/ui-interaction-motion.mjs`, supplied at integration) |
| Chat presentation | Folder and unfiled conversation rows, then open a chat and composer menus | `ui-chat-polish` | Sidebar previews, bubble/title/composer bounds at wide and narrow sizes, themes, attachments, long content and reload (`scripts/verify-scenarios/ui-chat-polish.mjs`, supplied at integration) |
| Live preview overlay | Open a comet with an incoming `agent:frame`, then drag `preview-card` inside the chat | `ui-live-overlay` | Real PNG frame paints; chat stays packed before and after pointer drag, with the card and composer reachable (`scripts/verify-scenarios/ui-live-overlay.mjs`, supplied at integration) |
| Live preview aspect | Open a comet with an incoming app frame (portrait, landscape, very tall) | `ui-preview-aspect` | `preview-card-stage` ratio equals the frame ratio and the frame fills the card (no bars, no crop); when the height reaches half the chat height the card gets narrower, at wide and narrow widths, in light and dark themes |
| Live card fit | Open a bot with 30 turns and a live app card, in single, 2- and 4-pane view, scrolled to top, middle and bottom | `apps/desktop/e2e/live-card-fit.spec.ts` | the docked card never covers a chat bubble at any scroll position, and each card has its window's aspect with no letterbox |
| Permission card | Open a bot, start main's real Screen Recording wait with a fake permission state, then turn it on | `apps/desktop/e2e/permission-card.spec.ts` | one card in the thread names the permission and why; its button opens only the exact Privacy_ScreenCapture pane; it leaves and the step continues when the permission is on |

The memory graph (`brain-graph`) is part of Cosmos, proved by `cosmos` and `note-open`. The connected model is the Brain rows, proved by `brain`.

## Not a verify-cli scenario

These need more than the fresh three-note vault, so they stay in Playwright specs:

- Pinned timeline dates (`happened_at` / `timeline: pinned`) — `apps/desktop/e2e/shell.spec.ts` ("list view: rows render chronologically"). `list-filter` checks order of the seed's distinct `happened_at` days (2026-03-15, 2026-02-15, 2026-01-15).
- A comet's page panel (`preview-deck`) — needs a comet that has opened a page (`apps/desktop/e2e/browser-preview.spec.ts`, `live-view.spec.ts`).
- Developers mode — `ENGRAM_DEVELOPER_FIXTURE` (`apps/desktop/e2e/developers.spec.ts`).
- Embedded browser — Windows-only (`apps/desktop/e2e/native-browser.spec.ts`).
- System volume (`system_volume` desktop tool) — unit-tested only (`apps/desktop/test/desktop-volume.test.ts`), because tests must not change the real volume.

## Brief shape

```json
{
  "criteria": [{ "id": "inbox", "cmd": "node scripts/verify-cli.mjs inbox", "expect": "exit 0 and JSON ok true" }],
  "scenarios": ["inbox"]
}
```

`orchestration/lib/loop.mjs` `verifierKindsFor` adds the `desktop` verifier when `scenarios` is non-empty or a criterion command matches `node scripts/verify-cli.mjs <scenario>`. `tests`, `spec` and `break` still run. Integration always runs `boot` plus those names (`integrationScenarios`).
