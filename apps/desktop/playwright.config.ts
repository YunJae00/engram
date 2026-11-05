import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env['ENGRAM_QUIET_HOST'] === '1' ? ['**/browser-focus.spec.ts', '**/browser-preview.spec.ts', '**/native-browser.spec.ts', '**/background-conversation-live.spec.ts', '**/app-work-live.spec.ts'] : [],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  // Retry in a fresh worker so a disconnected inspector cannot reuse a frozen app.
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
