import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEV_DEFAULTS, DevStore, devPreferences } from '../src/main/dev-store.js'
import type { DevSession } from '../src/shared/developers.js'

it('keeps development disabled by default and validates every preference boundary', () => {
  expect(DEV_DEFAULTS.enabled).toBe(false)
  expect(devPreferences({ enabled: true, mode: 'plan' })).toMatchObject({ enabled: true, mode: 'plan', isolate: true })
  for (const value of [{ mode: 'bypass' }, { enabled: 'true' }, { model: 'x'.repeat(201) }, { effort: 'unlimited' }, { token: 'secret' }]) expect(() => devPreferences(value)).toThrow()
})

it('serializes saves and preserves a corrupt settings file instead of resetting it', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-store-'))
  const file = join(root, 'state.json'), store = new DevStore(file)
  await store.load()
  store.data.preferences.enabled = true
  store.data.sessions.push({ id: 'interrupted', cwd: root, state: 'running', items: [{ id: 'partial', kind: 'assistant', text: 'Saved partial output', status: 'running' }], pending: [] } as unknown as DevSession)
  const first = store.save()
  store.data.preferences.model = 'selected-model'
  await Promise.all([first, store.save()])
  const restored = new DevStore(file)
  await restored.load()
  expect(restored.data.preferences).toMatchObject({ enabled: true, model: 'selected-model' })
  expect(restored.session('interrupted')).toMatchObject({ state: 'idle', pending: [] })
  expect(restored.session('interrupted').items[0]).toMatchObject({ text: 'Saved partial output', status: 'failed' })
  expect(restored.session('interrupted').items[1]?.text).toContain('Review the working tree')
  await writeFile(file, '{broken')
  await expect(new DevStore(file).load()).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{broken')
})

it('coalesces queued history saves without losing the latest state', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-store-burst-')), store = new DevStore(join(root, 'state.json'))
  const items = vi.fn(() => [{ id: 'answer', kind: 'assistant', text: 'Synthetic history' }])
  store.data.sessions.push({ id: 'task', cwd: root, state: 'idle', get items() { return items() }, pending: [] } as unknown as DevSession)
  const saves: Promise<void>[] = []
  for (let i = 0; i < 20; i++) { store.data.preferences.model = `model-${i}`; saves.push(store.save()) }
  await Promise.all(saves)
  expect(items).toHaveBeenCalledTimes(1)
  const restored = new DevStore(store.file)
  await restored.load()
  expect(restored.data.preferences.model).toBe('model-19')
  expect(restored.session('task').items[0]?.text).toBe('Synthetic history')
  items.mockImplementationOnce(() => { throw new Error('Fixture snapshot failure') })
  await expect(store.save()).rejects.toThrow('Fixture snapshot failure')
  store.data.preferences.model = 'recovered'
  await store.save()
  await restored.load()
  expect(restored.data.preferences.model).toBe('recovered')
})

it('encodes large histories in bounded pieces while preserving the existing file format', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-store-stream-')), store = new DevStore(join(root, 'state.json'))
  const text = '한글 "quoted"\n'.repeat(300)
  store.data.sessions.push({ id: 'large', cwd: root, state: 'idle', items: Array.from({ length: 700 }, (_, id) => ({ id: String(id), kind: 'assistant', text })), pending: [] } as unknown as DevSession)
  const original = JSON.stringify, lengths: number[] = []
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(value => { const result = original(value); lengths.push(result?.length ?? 0); return result })
  try { await store.save() } finally { spy.mockRestore() }
  expect(Math.max(...lengths)).toBeLessThan(10_000)
  const restored = new DevStore(store.file)
  await restored.load()
  expect(restored.session('large').items).toHaveLength(700)
  expect(restored.session('large').items.at(-1)?.text).toBe(text)
})
