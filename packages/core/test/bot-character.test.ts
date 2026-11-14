import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assignCharacter, CHARACTERS, characterIndex, defaultCharacter, FALLBACK_CHARACTER, fnv1a, isCharacterId, isOrbId, newBotId, ORBS, orbOf, resolveCharacter } from '../src/bot-character.js'
import { botPatchError, isBotAvatar } from '../src/bot-fields.js'
import { createBot, loadBots, updateBot } from '../src/bots.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

afterEach(() => { vi.restoreAllMocks() })

const vault = async (): Promise<VaultPaths> => initVault(await tmpVaultRoot('bot-character'), { git: false })

describe('bot character', () => {
  it('has exactly the 8 orbs in plan order and keeps the 16 legacy ids valid, each mapped to an orb by index', () => {
    expect(ORBS).toEqual(['orb-violet', 'orb-blue', 'orb-teal', 'orb-green', 'orb-amber', 'orb-rose', 'orb-lilac', 'orb-silver'])
    expect(CHARACTERS).toEqual([
      '01-bean-tilt', '02-cloud', '03-cashew', '04-lobe', '05-squircle', '06-triangle', '07-oval', '08-knob',
      '09-pill', '10-comma', '11-peanut', '12-crescent', '13-donut', '14-drop', '15-hourglass', '16-diamond',
    ])
    expect(FALLBACK_CHARACTER).toBe('orb-violet')
    for (const id of ORBS) expect(isCharacterId(id) && isOrbId(id) && orbOf(id) === id).toBe(true)
    CHARACTERS.forEach((id, i) => {
      expect(isCharacterId(id)).toBe(true)
      expect(isOrbId(id)).toBe(false)
      expect(orbOf(id)).toBe(ORBS[i % 8])
    })
    expect(orbOf('01-bean-tilt')).toBe('orb-violet')
    expect(orbOf('09-pill')).toBe('orb-violet')
    expect(orbOf('16-diamond')).toBe('orb-silver')
    for (const bad of ['17-star', 'orb-pink', 'plus', '', ' 07-oval', ' orb-blue', 7, null, undefined, {}]) expect(isCharacterId(bad)).toBe(false)
  })

  it('hashes UTF-8 bytes with FNV-1a', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('é')).toBe(0x1e9de8c1)
    expect(fnv1a('코멧')).toBe(0xed752cd3)
  })

  it('defaults to hash % 8, steps past the previous orb, wraps 7 to 0, and falls back for bad ids', () => {
    const own = fnv1a('bot-a') % 8
    expect(defaultCharacter('bot-a')).toBe(ORBS[own])
    expect(defaultCharacter('bot-a', own)).toBe(ORBS[(own + 1) % 8])
    expect(defaultCharacter('bot-a', (own + 3) % 8)).toBe(ORBS[own])
    expect(defaultCharacter('w3')).toBe('orb-silver')
    expect(defaultCharacter('w3', 7)).toBe('orb-violet')
    for (const bad of ['', '   ', undefined, null, 42]) expect(defaultCharacter(bad)).toBe(FALLBACK_CHARACTER)
    expect(characterIndex('07-oval')).toBe(6)
    expect(characterIndex('16-diamond')).toBe(7)
    expect(characterIndex('orb-silver')).toBe(7)
  })

  it('resolves stored picks, remaps legacy shapes from the real id, and falls back on malformed picks', () => {
    const hashed = defaultCharacter('bot-a')
    expect(resolveCharacter('bot-a', { character: '02-cloud' })).toBe('orb-blue')
    expect(resolveCharacter('bot-a', { character: 'orb-teal' })).toBe('orb-teal')
    for (const legacy of [undefined, { body: 1, face: 2, accessory: 3, palette: 4 }, { image: 'bot-avatars/bot-a.png' }, 'x', [1, 2]]) {
      expect(resolveCharacter('bot-a', legacy)).toBe(hashed)
      expect(resolveCharacter('bot-a', legacy)).toBe(resolveCharacter('bot-a', legacy))
    }
    for (const bad of [{ character: '99-star' }, { character: 3 }, { character: '02-cloud', extra: 1 }]) expect(resolveCharacter('bot-a', bad)).toBe(FALLBACK_CHARACTER)
    expect(resolveCharacter('', { body: 1, face: 1, accessory: 1, palette: 1 })).toBe(FALLBACK_CHARACTER)
    let reads = 0
    const hostile = { get character() { reads++; return reads === 1 ? '02-cloud' : 'evil' } }
    expect(resolveCharacter('bot-a', hostile)).toBe('orb-blue')
    expect(reads).toBe(1)
    expect(resolveCharacter('bot-a', { get character(): string { throw new Error('boom') } })).toBe(FALLBACK_CHARACTER)
  })

  it('validates the exact character shape and keeps legacy shapes valid', () => {
    expect(isBotAvatar({ character: '16-diamond' })).toBe(true)
    expect(isBotAvatar({ character: 'orb-silver' })).toBe(true)
    expect(botPatchError({ avatar: { character: '09-pill' } } as never)).toBeUndefined()
    expect(isBotAvatar({ body: 0, face: 0, accessory: 0, palette: 0 })).toBe(true)
    expect(isBotAvatar({ image: 'x.png' })).toBe(true)
    for (const bad of [{ character: '17-star' }, { character: '01-bean-tilt', image: 'x' }, { character: 1 }]) {
      expect(isBotAvatar(bad)).toBe(false)
      expect(botPatchError({ avatar: bad } as never)).toMatch(/8 orbs/)
    }
  })

  it('picks a free id inside a millisecond and refuses when all 65536 suffixes are taken', () => {
    const now = new Date('2026-11-12T00:00:00.000Z')
    const first = newBotId(new Set(), now, 0.5)
    expect(newBotId(new Set([first]), now, 0.5)).not.toBe(first)
    const all = new Set<string>()
    for (let n = 0; n < 0x10000; n++) all.add(`bot-${now.getTime().toString(36)}-${n.toString(16)}`)
    expect(() => newBotId(all, now, 0.5)).toThrow('no free comet id')
  })

  it('explicit picks skip the collision step', () => {
    expect(assignCharacter('bot-a', { id: 'bot-a' }, 'orb-rose')).toBe('orb-rose')
    expect(assignCharacter('bot-a', { id: 'bot-a' }, '09-pill')).toBe('orb-violet')
    expect(assignCharacter('bot-a', { id: 'bot-a' })).not.toBe(defaultCharacter('bot-a'))
    expect(assignCharacter('bot-a', undefined)).toBe(defaultCharacter('bot-a'))
  })
})

describe('createBot assignment', () => {
  it('stores a character from the real id, never repeating the previous face, stable on reload', async () => {
    const paths = await vault()
    const made = []
    for (let i = 0; i < 6; i++) made.push(await createBot(paths, { name: `Chat ${i}` }))
    const stored = await loadBots(paths)
    for (let i = 0; i < made.length; i++) {
      const prev = i === 0 ? undefined : characterIndex(resolveCharacter(made[i - 1]!.id, made[i - 1]!.avatar))
      expect(stored[i]!.avatar).toEqual({ character: defaultCharacter(made[i]!.id, prev) })
      if (i > 0) expect(stored[i]!.avatar).not.toEqual(stored[i - 1]!.avatar)
    }
    expect((await loadBots(paths)).map(b => b.avatar)).toEqual(stored.map(b => b.avatar))
  })

  it('two concurrent creates with the same base id get distinct ids and distinct adjacent faces', async () => {
    const paths = await vault()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const now = new Date('2026-11-12T00:00:00.000Z')
    const [a, b] = await Promise.all([createBot(paths, { name: 'A' }, now), createBot(paths, { name: 'B' }, now)])
    expect(a.id).not.toBe(b.id)
    expect(a.avatar).not.toEqual(b.avatar)
    expect((await loadBots(paths)).map(bot => bot.id)).toEqual([a.id, b.id])
  })

  it('an explicit orb is stored as is, a legacy pick as its orb; an unknown pick is refused before any write', async () => {
    const paths = await vault()
    const picked = await createBot(paths, { name: 'Pick', character: 'orb-rose' })
    expect(picked.avatar).toEqual({ character: 'orb-rose' })
    const same = await createBot(paths, { name: 'Again', character: '13-donut' })
    expect(same.avatar).toEqual({ character: 'orb-amber' })
    const before = await readFile(join(paths.cache, 'bots.json'))
    await expect(createBot(paths, { name: 'Bad', character: '17-star' as never })).rejects.toThrow('8 orbs')
    expect((await readFile(join(paths.cache, 'bots.json'))).equals(before)).toBe(true)
  })

  it('a legacy avatar remaps by real id; a failed write adds nothing', async () => {
    const paths = await vault()
    const bot = await createBot(paths, { name: 'Old' })
    await updateBot(paths, bot.id, { avatar: { body: 1, face: 2, accessory: 3, palette: 4 } })
    const old = (await loadBots(paths))[0]!
    expect(resolveCharacter(old.id, old.avatar)).toBe(defaultCharacter(bot.id))
    const next = await createBot(paths, { name: 'Next' })
    expect(next.avatar).toEqual({ character: defaultCharacter(next.id, characterIndex(defaultCharacter(bot.id))) })

    const broken = await vault()
    await mkdir(join(broken.cache, 'bots.json'), { recursive: true })
    await expect(createBot(broken, { name: 'Nope' })).rejects.toThrow()
    expect(await loadBots(broken)).toEqual([])
  })
})
