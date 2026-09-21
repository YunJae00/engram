# Accounts, history and workspace navigation

## Findings and changes

- Read-only Codex metadata inspection found six desktop conversations saved in the parent project folder, and none in the selected child folder. The old exact-cwd query excluded them. Catalog queries now normalize paths locally, include ancestor-folder conversations, explicitly include all model providers, and preserve the original folder when resuming. The preview and list show that folder. Sibling-prefix matches remain excluded.
- The all-folder catalog shows interactive conversations rather than allowing background `exec` runs to fill the first page. Project-scoped results still include `exec` sessions. Results remain bounded to 100 conversations; no native conversation is automatically resumed or replayed.
- Claude usage parsing skips structural fields without a utilization/reset window. Unknown actual windows remain unknown, not zero.
- The existing account control shows its account name and a remaining-limit ring. Hover or keyboard focus shows the provider, account and reported windows. Clicking opens account management. Session-pinned accounts are separate from the selected default for new tasks.
- AI settings group usage under each provider. Account dialogs use provider icons, a selected badge and a spaced footer. General includes version/update/support; Workspace contains computer control and developer preferences. Explanatory disclosures were removed without removing approval and computer-control safety notices.
- Cosmos and notes retain the current workspace sidebar. Opening a development task returns to Developers; switching explicitly to Chat changes the sidebar.
- The developer composer starts at one text row and grows with content. Top-bar controls use consistent gaps and centered hit areas.

## Verification

- Catalog and usage regression tests cover ancestor-folder selection, sibling exclusion, all-provider querying, interactive catalog filtering, and structural usage fields.
- Windows UI coverage checks Cosmos sidebar preservation, compact composer growth, top-bar spacing, grouped settings, account-limit hover, account switching, and existing task/history flows.
- Local typecheck, lint, unit and timing checks passed; the CSS scan passed after removing an unused class. A follow-up parent-folder import regression confirms that importing preserves the original folder without starting a runtime.
- The packaged app found six actual parent-folder Codex sessions and read a bounded 200-message preview without creating or resuming a task. Packaged language diagnostics, keyboard completion, Unicode command output and semantic indexing passed in isolated fixtures.
- Account dialogs, provider-grouped settings, the limit tooltip and compact composer were visually reviewed. CI and public release verification remain publication gates.

## Limits

History remains local to the chosen account store. Parent-folder conversations resume in their original folder, not in the currently selected child folder. The ring represents the lowest known reported window, not a guarantee that every model is available. Missing or delayed provider limits are displayed as unavailable. Provider outages and native session compatibility can still prevent resumption.
