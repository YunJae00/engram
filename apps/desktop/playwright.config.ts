import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  // A failed test retries in a FRESH worker (new Electron instance). This is
  // the mitigation for the environment flake where Playwright's inspector
  // session drop freezes the Electron main process mid-test (BLOCKERS.md
  // 2026-07-09) — the frozen app is abandoned and the retry starts clean.
  retries: 2,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
