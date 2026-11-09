import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EngramEvent } from '../src/shared/types.js'
import { en, followSettings, resolveUiLanguage, t, uiLocale } from '../src/renderer/src/i18n'
import { ko } from '../src/renderer/src/i18n-ko'
import { ko1 } from '../src/renderer/src/i18n-ko-1'
import { ko2 } from '../src/renderer/src/i18n-ko-2'
import { threadT } from '../src/renderer/src/lib/threadLang'
import { KO } from '../src/renderer/src/lib/threadLangKo'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
import { loadSettings } from '../src/main/settings.js'

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
type Bridge = Parameters<typeof followSettings>[0]

function fakeBridge(initial: unknown) {
  let listener: (event: EngramEvent) => void = () => undefined
  let release: (value: unknown) => void = () => undefined
  const read = new Promise(done => { release = done })
  return {
    bridge: {
      onEvent: (next: (event: EngramEvent) => void) => { listener = next; return () => undefined },
      settingsGet: () => read.then(() => ({ uiLanguage: initial })),
    } as unknown as Bridge,
    emit: (uiLanguage: unknown) => listener({ type: 'settings:changed', settings: { uiLanguage } } as unknown as EngramEvent),
    release: () => release(undefined),
  }
}

describe('i18n', () => {
  it('ko and en have identical keys and placeholders', () => {
    const partKeys = [...Object.keys(ko1), ...Object.keys(ko2)]
    expect(new Set(partKeys).size).toBe(partKeys.length)
    expect(partKeys.sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]))
    expect(ko['mission.new']).toMatch(/[가-힣]/)
    expect(ko['help.shortcutsTitle']).not.toBe(en['help.shortcutsTitle'])
  })

  it('system ko-KR→ko, en-US→en, ja-JP→ko, default is system', () => {
    expect(resolveUiLanguage('system', 'ko-KR')).toBe('ko')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('system', 'ja-JP')).toBe('ko')
    expect(resolveUiLanguage(undefined, 'en')).toBe('en')
    expect(resolveUiLanguage('fr', 'en-GB')).toBe('en')
    expect(resolveUiLanguage('system', 'eng')).toBe('ko')
    expect(resolveUiLanguage('ko', 'en-US')).toBe('ko')
    expect(resolveUiLanguage('en', 'ko-KR')).toBe('en')
    // Node has no navigator, so the unset preference resolves as system through the en-US fallback.
    expect(t('mission.new')).toBe(en['mission.new'])
    expect(uiLocale()).toBe('en-US')
  })

  it('saved uiLanguage reaches t', async () => {
    const saved = fakeBridge('en')
    const loading = followSettings(saved.bridge)
    saved.release()
    await loading
    expect(t('mission.new')).toBe(en['mission.new'])
    expect(uiLocale()).toBe('en-US')
    saved.emit('ko')
    expect(t('mission.panels', { count: 3 })).toBe(ko['mission.panels'].replace('{count}', '3'))
    expect(uiLocale()).toBe('ko-KR')
    saved.emit('bogus')
    expect(t('mission.new')).toBe(en['mission.new'])
    expect(uiLocale()).toBe('en-US')

    const racing = fakeBridge('en')
    const pending = followSettings(racing.bridge)
    racing.emit('ko')
    racing.release()
    await pending
    expect(t('mission.new')).toBe(ko['mission.new'])
    racing.emit('en')
    expect(t('mission.new')).toBe(en['mission.new'])
    racing.emit('ko')

    const failing = { onEvent: () => () => undefined, settingsGet: vi.fn().mockRejectedValue(new Error('gone')) }
    await followSettings(failing as unknown as Bridge)
    expect(uiLocale()).toBe('ko-KR')
    await followSettings({ settingsGet: () => undefined } as unknown as Bridge)
    expect(uiLocale()).toBe('ko-KR')
  })

  it('saved uiLanguage reaches t through main settings defaults and validation', async () => {
    await mkdir(resolve('tmp'), { recursive: true })
    fixture.root = await mkdtemp(resolve('tmp/settings-ui-language-'))
    try {
      expect((await loadSettings()).uiLanguage).toBe('system')
      const file = resolve(fixture.root, 'settings.json')
      await writeFile(file, JSON.stringify({ uiLanguage: 'ko', theme: 'dark' }))
      expect(await loadSettings()).toMatchObject({ uiLanguage: 'ko', theme: 'dark' })
      await writeFile(file, JSON.stringify({ uiLanguage: 'ja' }))
      expect((await loadSettings()).uiLanguage).toBe('system')
      await writeFile(file, JSON.stringify({ theme: 'light' }))
      expect((await loadSettings()).uiLanguage).toBe('system')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('conversation labels follow the conversation language', async () => {
    const saved = fakeBridge('ko')
    const loading = followSettings(saved.bridge)
    saved.release()
    await loading
    expect(t('press.askHint')).toBe(ko['press.askHint'])
    expect(threadT('en')('press.askHint')).toBe(en['press.askHint'])
    expect(threadT('en')('bots.thinking')).toBe(en['bots.thinking'])
    expect(threadT('en')('bots.stepSearchWeb', { arg: 'q' })).toBe(en['bots.stepSearchWeb'].replace('{arg}', 'q'))
    expect(threadT('en')('mission.panels', { count: 2 })).toBe(en['mission.panels'].replace('{count}', '2'))
    saved.emit('en')
    expect(t('press.askHint')).toBe(en['press.askHint'])
    expect(KO['press.askHint']).toBeUndefined()
    expect(KO['mission.panels']).toBeUndefined()
    expect(threadT('ko')('press.askHint')).toBe(ko['press.askHint'])
    expect(threadT('ko')('mission.panels', { count: 2 })).toBe(ko['mission.panels'].replace('{count}', '2'))
    expect(threadT('ko')('bots.thinking')).toBe(KO['bots.thinking'])
    expect(threadT('ko')('bots.stepSearchWeb', { arg: 'q' })).toBe(KO['bots.stepSearchWeb']!.replace('{arg}', 'q'))
  })
})
