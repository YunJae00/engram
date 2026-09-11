import { defineConfig } from 'vitest/config'

// Run process and wall-clock tests sequentially, separately from filesystem-heavy tests.
const TIMING_SENSITIVE = [
  'packages/core/test/engine-timeout.test.ts',
  'packages/core/test/reaper.test.ts',
  'packages/core/test/spawn-argv-guard.test.ts',
  'packages/core/test/spawn-lifecycle.test.ts',
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // Bound the resident workers while vault tests create files and processes.
          maxWorkers: 2,
          minWorkers: 1,
          // Vault-heavy tests hit real filesystem I/O (init, watch, git) —
          // generous timeouts keep them stable on slower/AV-scanned disks.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            // Pure renderer-lib logic (topic labels, grouping) — no DOM, node is fine.
            'apps/desktop/test/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', ...TIMING_SENSITIVE],
        },
      },
      {
        test: {
          name: 'timing',
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          include: TIMING_SENSITIVE,
          // One file at a time, one worker: these measure the clock.
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
          // …and even alone they can lose to a machine already at 100% (a
          // dev box running the app under test, an antivirus sweep). A retry
          // cannot hide a real defect — a broken watchdog fails all three —
          // but it stops a busy laptop from reading as a red build.
          retry: 2,
        },
      },
    ],
  },
})
