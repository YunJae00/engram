# First-run preview

Run `pnpm --filter desktop build`, then `pnpm --filter desktop exec playwright test e2e/onboarding.spec.ts` from the repository root.

The test creates isolated workspaces under `tmp/` and leaves these screenshots in `tmp/onboarding-preview/`:

1. `01-workspace.png` — default folder and setup introduction.
2. `02-connect-ai.png` — provider choices.
3. `03-sign-in-waiting.png` — browser handoff, reopen and cancel controls.
4. `04-connected.png` — completed connection.
5. `05-first-screen.png` — first conversation screen.
6. `06-browser-start.png` — direct browser entry.
7. `07-browser-and-chat.png` — browser alongside the conversation.
8. `08-recent-sites.png` — five compact site icons plus New, using fixture names and icons.

Authentication states are simulated at the IPC boundary. No real credentials are used and no provider subscription quota is consumed. The browser navigation uses a local test server. This verifies the interface and persistence, not live provider authorization; final sign-in still requires the account owner in the provider's browser flow.

The separate skip test creates a usable workspace without AI. Existing workspace folders and installed application data are not changed.
