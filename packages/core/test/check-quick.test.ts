import { afterEach, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn(() => ({ status: 0 })))
vi.mock('node:child_process', () => ({ spawnSync: run }))
const argv = process.argv
afterEach(() => { process.argv = argv; vi.restoreAllMocks(); vi.resetModules(); run.mockReset().mockReturnValue({ status: 0 }) })

it('uses the same cached compiler and lint checks, then explicit unit tests and all hygiene scans', async () => {
  process.argv = ['node', 'check-quick', 'apps/desktop/test/codex-native.test.ts']
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await import(new URL('../../../scripts/check-quick.mjs', import.meta.url).href)
  const commands = run.mock.calls as unknown as [string, string[]][]
  expect(commands.map(([, args]) => args[0])).toEqual(['node_modules/typescript/bin/tsc', 'node_modules/typescript/bin/tsc', 'node_modules/eslint/bin/eslint.js', 'node_modules/vitest/vitest.mjs', 'scripts/todo-scan.mjs', 'scripts/css-orphan-scan.mjs'])
  expect(commands[3]![1]).toContain('apps/desktop/test/codex-native.test.ts')
})

it('uses the changed dependency graph by default and stops on the first failed check', async () => {
  process.argv = ['node', 'check-quick']
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('failed check') })
  run.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 })
  await expect(import(new URL('../../../scripts/check-quick.mjs', import.meta.url).href)).rejects.toThrow('failed check')
  expect((run.mock.calls as unknown as [string, string[]][])[3]![1]).toEqual(['node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', '--changed', 'origin/main', '--passWithNoTests'])
  expect(run).toHaveBeenCalledTimes(4)
})
