import { afterEach, describe, expect, it, vi } from 'vitest'
import { ONBOARD_BOT_KEY, readOnboardBot, saveOnboardBot, takeOnboardBot } from '../src/renderer/src/lib/onboardBot'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
})
afterEach(() => store.clear())

describe('onboardBot', () => {
  it('readOnboardBot keeps strings, trims, clips name to 60 UTF-16 units and label to 40 code points', () => {
    expect(readOnboardBot(JSON.stringify({ name: '  Sol ', label: ' Helper ', extra: 1 }))).toEqual({ name: 'Sol', label: 'Helper' })
    expect(readOnboardBot(JSON.stringify({ name: '   ', label: '' }))).toEqual({ name: null, label: null })
    expect(readOnboardBot(JSON.stringify({ name: null, label: null }))).toEqual({ name: null, label: null })
    expect(readOnboardBot(JSON.stringify({ name: 'a'.repeat(80), label: null }))!.name).toBe('a'.repeat(60))
    expect(readOnboardBot(JSON.stringify({ name: '😀'.repeat(40), label: null }))!.name).toHaveLength(60)
    expect(readOnboardBot(JSON.stringify({ name: null, label: '😀'.repeat(50) }))!.label).toBe('😀'.repeat(40))
    saveOnboardBot({ name: 'Sol', label: null })
    expect(takeOnboardBot()).toEqual({ name: 'Sol', label: null })
    expect(store.has(ONBOARD_BOT_KEY)).toBe(false)
    expect(takeOnboardBot()).toBeNull()
  })

  it('readOnboardBot returns null for bad JSON, arrays, non-objects and wrong field types', () => {
    for (const raw of [null, '', '{', '[]', '[{"name":"a","label":null}]', '42', '"text"', 'null', 'true',
      '{"name":1,"label":null}', '{"name":"a","label":false}', '{"name":"a"}', '{"label":"b","name":{}}']) {
      expect(readOnboardBot(raw)).toBeNull()
    }
    store.set(ONBOARD_BOT_KEY, '{broken')
    expect(takeOnboardBot()).toBeNull()
    expect(store.has(ONBOARD_BOT_KEY)).toBe(false)
  })
})
