import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

it('drops an old recording preference while preserving all other saved choices', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fixture.root = await mkdtemp(resolve('tmp/settings-without-recording-'))
  const file = resolve(fixture.root, 'settings.json')
  await writeFile(file, JSON.stringify({ recordTasks: true, workMap: true, theme: 'dark', claudeModel: 'chosen' }))
  const loaded = await loadSettings()
  expect(loaded).not.toHaveProperty('recordTasks')
  expect(loaded).toMatchObject({ workMap: true, theme: 'dark', claudeModel: 'chosen' })
  await updateSettings(value => ({ ...value, autoStart: true }))
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved).not.toHaveProperty('recordTasks')
  expect(saved).toMatchObject({ autoStart: true, workMap: true, theme: 'dark', claudeModel: 'chosen' })
})
