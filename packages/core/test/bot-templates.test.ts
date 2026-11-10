import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { botPatchError, isBotAvatar } from '../src/bot-fields.js'
import { BUILTIN_TEMPLATES, exportTemplate, importTemplate } from '../src/bot-templates.js'
import { createBot, loadBots, type Bot } from '../src/bots.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const fail = vi.hoisted(() => ({ next: false }))
vi.mock('../src/bots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bots.js')>()
  return {
    ...actual,
    updateBot: (...args: Parameters<typeof actual.updateBot>) => {
      if (fail.next) { fail.next = false; return Promise.reject(new Error('disk full')) }
      return actual.updateBot(...args)
    },
  }
})

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const vault = async (): Promise<VaultPaths> => initVault(await tmpVaultRoot('bot-templates'), { git: false })
const botsBytes = (paths: VaultPaths) => readFile(join(paths.cache, 'bots.json')).catch(() => null)
const valid = { id: 'research', name: '리서치', purpose: '조사', label: '자료 조사', avatar: { body: 1, face: 2, accessory: 4, palette: 3 } }

describe('bot templates', () => {
  it('five built-in templates valid, each with its avatar accessory', () => {
    expect(BUILTIN_TEMPLATES.map(t => [t.id, t.name, t.avatar?.accessory])).toEqual([
      ['morning-briefing', '아침 브리핑', 7],
      ['research', '리서치', 4],
      ['mail-draft', '메일 초안', 8],
      ['schedule', '일정 정리', 5],
      ['study-helper', '공부 도우미', 2],
    ])
    expect(Object.isFrozen(BUILTIN_TEMPLATES)).toBe(true)
    for (const t of BUILTIN_TEMPLATES) {
      expect(isBotAvatar(t.avatar)).toBe(true)
      expect(t.label).toBeTruthy()
      expect([...t.label!].length).toBeLessThanOrEqual(40)
      expect(t.purpose.length).toBeGreaterThan(0)
      expect(t.purpose.length).toBeLessThanOrEqual(2000)
      expect(t.skills).toBeUndefined()
      expect(botPatchError({ label: t.label, avatar: t.avatar, templateId: t.id })).toBeUndefined()
      expect(Object.isFrozen(t) && Object.isFrozen(t.avatar)).toBe(true)
    }
  })

  it('export omits memory, history, secrets and uploaded image; keeps character avatar', async () => {
    const avatar = { body: 1, face: 2, accessory: 3, palette: 4 }
    const bot: Bot = {
      id: 'bot-abc-123', name: 'Helper', purpose: 'my password is hunter22x', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z', tasks: [{ id: 'task-1', name: 't', goal: 'g' }],
      webSites: [{ origin: 'https://example.com', visits: 2 }], declined: ['x'], primary: true, hidden: true,
      notify: 'off', avatar, label: 'Lab', skills: ['web'], templateId: 'Bad Id',
    }
    const out = exportTemplate(bot)
    for (const key of Object.keys(out)) expect(['id', 'name', 'purpose', 'label', 'avatar', 'skills']).toContain(key)
    const json = JSON.stringify(out)
    expect(json).not.toContain('hunter22x')
    expect(json).not.toContain(bot.id)
    expect(out.id).toBe('custom')
    expect(out.avatar).toEqual(avatar)
    expect(out.avatar).not.toBe(avatar)
    expect(out.skills).toEqual(['web'])
    expect(out.skills).not.toBe(bot.skills)
    expect(exportTemplate({ ...bot, templateId: 'research' }).id).toBe('research')
    expect(exportTemplate({ ...bot, avatar: { image: 'face.png' } }).avatar).toBeUndefined()
    const label = `pin abc ${'x'.repeat(32)}`
    expect([...label].length).toBe(40)
    const masked = exportTemplate({ ...bot, label })
    expect(masked.label).not.toContain('abc')
    await expect(importTemplate(await vault(), masked)).resolves.toMatchObject({ templateId: 'custom' })
  })

  it('import creates new id, ignores incoming bot fields', async () => {
    const paths = await vault()
    const incoming = { ...valid, botId: 'bot-evil-1', bot: { id: 'bot-evil-2' }, primary: true, createdAt: '2000-01-01T00:00:00.000Z' }
    const first = await importTemplate(paths, incoming)
    expect(first.id).toMatch(/^bot-/)
    for (const value of ['bot-evil-1', 'bot-evil-2', 'research']) expect(first.id).not.toBe(value)
    expect(first.createdAt).not.toBe(incoming.createdAt)
    expect(first.templateId).toBe('research')
    const second = await importTemplate(paths, incoming)
    expect(second.id).not.toBe(first.id)
    const stored = await loadBots(paths)
    expect(stored.map(b => b.id)).toEqual([first.id, second.id])
    expect(stored[0]).toMatchObject({ label: '자료 조사', avatar: valid.avatar, templateId: 'research' })
  })

  it('import creates new id even when time and random repeat', async () => {
    const paths = await vault()
    vi.useFakeTimers({ now: new Date('2026-11-10T00:00:00.000Z'), toFake: ['Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const plain = await createBot(paths, { name: 'Made by hand' })
    const ids = await Promise.all([importTemplate(paths, valid), importTemplate(paths, valid)]).then(bots => bots.map(b => b.id))
    ids.push((await importTemplate(paths, valid)).id)
    const all = [plain.id, ...ids]
    expect(new Set(all).size).toBe(4)
    expect((await loadBots(paths)).map(b => b.id)).toEqual(all)
  })

  it('import rejects invalid template without writing', async () => {
    const bad: unknown[] = [
      null, [], 'text', { ...valid, name: '  ' }, { ...valid, id: 'Bad Id' }, { ...valid, id: undefined },
      { ...valid, avatar: { image: 'x' } }, { ...valid, avatar: { ...valid.avatar, accessory: 9 } },
      { ...valid, label: 'a'.repeat(41) }, { ...valid, skills: ['a', 1] }, { ...valid, purpose: 3 },
    ]
    for (const seed of [false, true]) {
      const paths = await vault()
      if (seed) await createBot(paths, { name: 'Existing' })
      const before = await botsBytes(paths)
      for (const template of bad) await expect(importTemplate(paths, template)).rejects.toThrow()
      expect(await botsBytes(paths)).toEqual(before)
    }
  })

  it('import removes the new bot when saving the template fields fails', async () => {
    const paths = await vault()
    fail.next = true
    await expect(importTemplate(paths, valid)).rejects.toThrow('disk full')
    expect(await loadBots(paths)).toEqual([])
  })
})
