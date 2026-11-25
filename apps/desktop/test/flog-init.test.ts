import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'

const root = resolve(__dirname, '../../../tmp/flog-init-fixture')
const linesIn = (folder: string): string[] => {
  const file = join(folder, 'engram-main.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}
const freshLog = async () => { vi.resetModules(); return import('../src/main/flog.js') }

beforeEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('writes a line logged before init into the file after init, ahead of later lines', async () => {
  const { flog, initLog } = await freshLog()
  const folder = join(root, 'early')
  flog('orchard', 'apples picked before the shed had a door')
  flog('orchard', 'pears picked before the shed had a door')
  expect(existsSync(folder)).toBe(false)
  initLog(folder)
  flog('orchard', 'plums picked after')
  await expect.poll(() => linesIn(folder).length).toBe(3)
  expect(linesIn(folder).map(line => line.replace(/^\S+ /, ''))).toEqual([
    '[orchard] apples picked before the shed had a door',
    '[orchard] pears picked before the shed had a door',
    '[orchard] plums picked after',
  ])
})

it('lets a plain script pick its own folder and finds its lines there', async () => {
  const { flog, initLog } = await freshLog()
  const folder = join(root, 'script', 'logs')
  initLog(folder)
  flog('tide-table', 'high water at noon')
  await expect.poll(() => linesIn(folder)).toEqual([expect.stringContaining('[tide-table] high water at noon')])
})

it('keeps the first folder when init is called a second time', async () => {
  const { flog, initLog } = await freshLog()
  const first = join(root, 'first'), second = join(root, 'second')
  initLog(first)
  flog('bakery', 'rye in the oven')
  initLog(second)
  flog('bakery', 'rye out of the oven')
  await expect.poll(() => linesIn(first).length).toBe(2)
  expect(existsSync(second)).toBe(false)
})
