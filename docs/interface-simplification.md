# Navigation and settings simplification

## Reviewed surfaces

- Sidebar and collapsed-sidebar header, Engram menu, workspace management, search/command palette, conversation and Developers controls.
- General, AI/accounts, Workspace, Memory/data and Help settings; provider account dialog and external-client connections.

## Changes

- One Comets/Developers mode toggle, using the existing Comet mark. Remove duplicate mode entries from the Engram menu; retain Cosmos, notes, routines and search.
- Keep GitHub backup in Memory & data instead of duplicating it inside workspace management.
- Replace long activity-log and backup instructions with aligned action rows. Remove the non-interactive coding-session explanation duplicated by the actual Workspace control.
- Shorten Workspace labels and status text, remove empty saved-decision sections and the redundant account-dialog introduction.
- Remove the composer session-options menu; show the actual working folder below the session title, with truncation and a full-path tooltip.
- Show progress for update checks/downloads, semantic startup, skill/file loading and task settings. Disable duplicate update actions and expose recoverable failures instead of silently stopping.
- Keep privacy, external data sharing, provider-hook permissions, cancellation and destructive-action guidance visible. Keep Help explanatory and preserve keyboard/accessibility labels.

Context-specific access is intentional: model settings from a model picker, account management from the usage indicator, and search through keyboard commands are not competing primary navigation controls. Filing AI remains separate from conversation AI.

No account, permission, retention or session execution behavior changes. The release also includes the merged attachment-copy contribution and its full-text/safety/accessibility fixes.
