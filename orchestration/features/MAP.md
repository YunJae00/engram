# Feature Map

How to reach each major surface of the desktop app, and which `verify-cli` scenario proves it. A row is grounded in the test ids the renderer actually renders. The command is the proof; this file only says where to look.

Run from the repo root:

```
node scripts/verify-cli.mjs --list
node scripts/verify-cli.mjs <scenario>          # uses apps/desktop/out/main/index.js
node scripts/verify-cli.mjs <scenario> --build  # builds desktop first
```

`verify-cli` launches that build on a fresh vault (`ENGRAM_ENGINE=none`, git and autotidy off, window hidden) with three notes: `n-hello-0001` ("Hello note"), `n-argo-0001`, `n-argo-0002` (derived from the first Argo note). It waits until `shell` is visible, then calls the scenario's `run(page, { app, paths, expect, openActivity, log })`. `openActivity` is `apps/desktop/e2e/navigation.ts`. The process prints one JSON line and exits 0 only when `ok` is true.

A new scenario is a file `scripts/verify-scenarios/<name>.mjs` exporting that `run`. It returns `{ ok, evidence }`. A scenario that needs more than the fresh vault also exports `launch`: `env` adds variables to the app's environment and `seed(core, paths)` fills the vault before the app starts (`ui-live-overlay` seeds a comet and sets `ENGRAM_BROWSER_EXTERNAL=1`). Shared helpers live in `scripts/verify-scenarios/lib/`: `frame-fixture.mjs` makes a real PNG frame and sends the main-process events that carry it, `chat-layout.mjs` measures the chat as packed blocks. Add its row here in the same change. The Conductor has a verifier add it; an implementer does not (`orchestration/CONDUCTOR.md`).

| Surface | How to reach it | Scenario | What the scenario asserts |
| --- | --- | --- | --- |
| Shell / boot | Launch. Home is Comets. | `boot` | `shell`, `topbar`, `bots-view` (`App.tsx`, `TopBar.tsx`, `BotsView.tsx`) |
| List / timeline | Engram menu → List, or `openActivity(page, 'list')` → `activity-list` | `list-filter` | `list-view` shows 3 `list-row`s; `.list-date` is newest-first (`chronoDate` in `ListView.tsx` is `happened_at` or `updated`); filter "Hello" leaves 1; the row opens `note-sheet` |
| Note open | Cosmos star, or the list row | `note-open` | `openActivity(page, 'sky')`, collapse `cosmos-chat-collapse`, click `[data-node-id="n-hello-0001"]`, `note-sheet` contains "The very first note", Escape closes it |
| Palette | Ctrl/Cmd+P | `palette` | `palette-input` query "Hello" opens `note-editor` / `cm-host` |
| Cosmos | Engram menu → Cosmos, or `openActivity(page, 'sky')` → `activity-sky` | `cosmos` | `sky-view`, `brain-graph` (`SkyCanvas.tsx`), `cosmos-chat`; collapse, then `cosmos-chat-open` restores `cosmos-chat-input` |
| Mission control / panels | On Comets, the top-bar split (`mission-layout-4`), or `openActivity(page, 'mission')` | `mission` | `mission-control` with `mission-tile-0` and `mission-tile-3`; `mission-add-0` opens `mission-add-menu`; Escape closes it |
| Comets | Home, or Ctrl/Cmd+L | `comets` | `bots-view`, `comet-welcome`, `welcome-input`; `cosmos-chat` is absent on this tab |
| Brain (AI connection) | `connect-banner` → "AI settings" when no engine is connected | `brain` | Banner opens `settings-view` on `settings-nav-ai`; `brain-claude-status` and `brain-codex-status` (`EngineSettings.tsx`) |
| Capture | Second window, not a shell route. Preload `showQuickComet` → `quick:show` → `#quick` | `capture` | `quick-capture` and `quick-input`; Escape hides the window |
| Inbox (scrap pile) | Ctrl/Cmd+Shift+P, command "Open scrap pile (inbox)" | `inbox` | `inbox-overlay` / `inbox-list` shows the empty copy; Escape closes it |
| Settings | Sidebar `activity-settings`, or `openActivity(page, 'settings')` | `settings` | `settings-view`, About via `settings-nav-help` / `help-panel`, `settings-export-logs`; Escape closes it |
| Live card (work preview overlay) | A comet's chat while its turn has a page open: `comet:step` `read_open_page:` then `agent:live` and `agent:frame` on `engram:event` (`PreviewDeck.tsx`, `usePreviewFrames.ts`, `FrameScreen.tsx`) | `ui-live-overlay` (also run as `ui-live-fixture-20261106`, the brief's criterion name) | A real 1280x800 PNG paints `preview-card` (`canvas[data-painted][data-format=png]`), `live-address` is absent; packed blocks: card inside `.bots-chat`, above `bots-thread`, over no control, `.bots-chat` as wide as `.bots-main`, card is the top hit target; a mouse drag from the card across the chat lands its press and moves on the card, stays in the chat, and leaves the same packed layout |

The memory graph (`brain-graph`) is part of Cosmos, proved by `cosmos` and `note-open`. The connected model is the Brain rows, proved by `brain`.

## Not a verify-cli scenario

These need more than the fresh three-note vault, so they stay in Playwright specs:

- Pinned timeline dates (`happened_at` / `timeline: pinned`) — `apps/desktop/e2e/shell.spec.ts` ("list view: rows render chronologically"). `list-filter` only checks order of the seed's `updated` dates.
- A comet's page panel beside the chat (`web-pane`) and a stacked `preview-deck` of several pages — need a real agent browser (`apps/desktop/e2e/browser-preview.spec.ts`, `live-view.spec.ts`). The single floating card is `ui-live-overlay`.
- Developers mode — `ENGRAM_DEVELOPER_FIXTURE` (`apps/desktop/e2e/developers.spec.ts`).
- Embedded browser — Windows-only (`apps/desktop/e2e/native-browser.spec.ts`).

## Brief shape

```json
{
  "criteria": [{ "id": "inbox", "cmd": "node scripts/verify-cli.mjs inbox", "expect": "exit 0 and JSON ok true" }],
  "scenarios": ["inbox"]
}
```

`orchestration/lib/loop.mjs` `verifierKindsFor` adds the `desktop` verifier when `scenarios` is non-empty or a criterion command matches `node scripts/verify-cli.mjs <scenario>`. `tests`, `spec` and `break` still run. Integration always runs `boot` plus those names (`integrationScenarios`).
