import { defineConfig } from 'vitest/config'

// Two lanes (2026-08-06, after three gates in one day each lost a DIFFERENT
// timing test to full-suite load): the three files that assert on real
// wall-clock behaviour — child-process watchdogs, disk-poll round trips —
// run SEQUENTIALLY in their own project, because they stopped surviving 90
// parallel files hammering the same disk. Everything else keeps full
// parallelism. Each timing file still passes alone in seconds; this only
// stops the herd from trampling them.
// The membership rule, not a list of names: a file belongs here if it SPAWNS
// REAL PROCESSES or measures the clock. Adding them one at a time as each
// flaked was whack-a-mole (three rounds on 2026-08-10) — the whole family
// goes in, and a new spawning test should be added here when it is written.
// Every one of these passes in seconds alone; they only fail when 80 parallel
// files are fighting them for the same disk and cores.
const TIMING_SENSITIVE = [
  'packages/core/test/engine.test.ts',
  'packages/core/test/engine-timeout.test.ts',
  'packages/core/test/engine-detection-hysteresis.test.ts',
  'packages/core/test/reaper.test.ts',
  'packages/core/test/spawn-argv-guard.test.ts',
  'packages/core/test/spawn-lifecycle.test.ts',
  'packages/core/test/detect-single-flight.test.ts',
  'packages/core/test/chat-session.test.ts',
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
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
