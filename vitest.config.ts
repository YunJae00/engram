import { defineConfig } from 'vitest/config'

const TIMING_SENSITIVE = [
  'packages/core/test/engine-timeout.test.ts',
  'packages/core/test/reaper.test.ts',
  'packages/core/test/spawn-argv-guard.test.ts',
  'packages/core/test/spawn-lifecycle.test.ts',
]

export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/desktop/test/**/*.test.ts',
            'orchestration/**/*.test.mjs',
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
          retry: 2,
        },
      },
    ],
  },
})
