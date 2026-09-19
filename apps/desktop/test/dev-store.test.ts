import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DEV_DEFAULTS, DevStore, devPreferences } from '../src/main/dev-store.js'

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
  const first = store.save()
  store.data.preferences.model = 'selected-model'
  await Promise.all([first, store.save()])
  const restored = new DevStore(file)
  await restored.load()
  expect(restored.data.preferences).toMatchObject({ enabled: true, model: 'selected-model' })
  await writeFile(file, '{broken')
  await expect(new DevStore(file).load()).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{broken')
})
