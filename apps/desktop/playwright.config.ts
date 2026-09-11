import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  // Retry in a fresh worker so a disconnected inspector cannot reuse a frozen app.
  retries: 2,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
