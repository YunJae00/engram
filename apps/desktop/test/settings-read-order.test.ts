import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
import { loadSettings, updateSettings } from '../src/main/settings.js'

it('reads selections only after preceding queued saves finish', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fixture.root = await mkdtemp(resolve('tmp/settings-read-order-'))
  const first = updateSettings(value => ({ ...value, claudeModel: 'chosen' }))
  const second = updateSettings(value => ({ ...value, aiSelections: { filing: { engine: 'codex', model: 'catalog-model' } } }))
  expect(await loadSettings()).toMatchObject({ claudeModel: 'chosen', aiSelections: { filing: { engine: 'codex', model: 'catalog-model' } } })
  await Promise.all([first, second])
})
