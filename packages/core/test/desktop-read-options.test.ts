import { expect, it, vi } from 'vitest'
import { desktopReadOptions } from '../src/desktop-read-options.js'
import { quietDesktopTools } from '../src/desktop-quiet-tools.js'

it('passes skeleton and validated subtree identities through the tool boundary', async () => {
  const scan = vi.fn().mockResolvedValue('{"truncated":true}')
  const tools = quietDesktopTools({ scan, set: vi.fn(), press: vi.fn(), text: vi.fn() })
  const read = tools.find(tool => tool.name === 'app_read')!
  await read.run({ app: 'Fixture', mode: 'skeleton' }, { task: 'Read the outline' })
  expect(scan).toHaveBeenLastCalledWith('Fixture', undefined, undefined, { mode: 'skeleton' })
  const snapshot = 'a'.repeat(32)
  await read.run({ app: 'Fixture', root: 'c3', snapshot }, { task: 'Read the region' })
  expect(scan).toHaveBeenLastCalledWith('Fixture', undefined, undefined, { root: 'c3', snapshot })
  expect(desktopReadOptions({ root: 'c3' })).toBeNull()
  expect(desktopReadOptions({ mode: 'skeleton', root: 'c3', snapshot })).toBeNull()
})
