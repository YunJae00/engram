import { describe, expect, it } from 'vitest'
import { addBotTask, appendBotTurn, createBot, declineStanding, deleteBot, dismissBotSuggestion, loadBots, loadDismissedSuggestions, readBotTranscript, recommendBots, renameBot, titleFromMessage, UNTITLED_BOT_NAME, updateBot, AVATAR_RANGES } from '../src/bots.js'
import { AVATAR_RANGES as FIELD_RANGES, botPatchError, isBotAvatar } from '../src/bot-fields.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'
import { recordBotSites } from '../src/bots.js'
import { archiveBotTranscript } from '../src/bots.js'
import { access, appendFile, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

it('keeps concurrent appends intact through compaction and serializes archiving', async () => {
  const paths = await initVault(await tmpVaultRoot('chat-compaction'), { git: false })
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'fixture.jsonl')
  await writeFile(file, Array.from({ length: 401 }, (_, i) => JSON.stringify({ role: 'user', text: `${i}:${'x'.repeat(6000)}`, at: '2026-01-01' })).join('\n') + '\n')
  await Promise.all(Array.from({ length: 16 }, (_, i) => appendBotTurn(paths, 'fixture', { role: 'assistant', text: `new-${i}`, at: '2026-01-02' })))
  expect((await readBotTranscript(paths, 'fixture')).slice(-16).map(turn => turn.text)).toEqual(Array.from({ length: 16 }, (_, i) => `new-${i}`))
  await appendFile(file, '\nbroken json\n')
  expect((await readBotTranscript(paths, 'fixture', 1))[0]?.text).toBe('new-15')
  expect(await readBotTranscript(paths, 'fixture', 0)).toEqual([])
  await Promise.all([
    appendBotTurn(paths, 'fixture', { role: 'user', text: 'before archive', at: '2026-01-03' }),
    archiveBotTranscript(paths, 'fixture'),
    appendBotTurn(paths, 'fixture', { role: 'user', text: 'after archive', at: '2026-01-03' }),
  ])
  expect((await readBotTranscript(paths, 'fixture')).map(turn => turn.text)).toEqual(['after archive'])
  const archive = (await readdir(dir)).find(name => name.startsWith('fixture.') && name !== 'fixture.jsonl')!
  expect(await readFile(join(dir, archive), 'utf8')).toContain('before archive')
})

it('keeps a bounded origin-only website history per comet without overwriting concurrent renames', async () => {
  const paths = await initVault(await tmpVaultRoot('bot-sites'), { git: false })
  const bot = await createBot(paths, { name: 'Scout' })
  await Promise.all([
    recordBotSites(paths, bot.id, ['https://example.com/private?token=secret', 'https://example.com/next', 'file:///private', 'https://user:pass@example.net']),
    renameBot(paths, bot.id, 'Research'),
  ])
  const saved = (await loadBots(paths))[0]!
  expect(saved.name).toBe('Research')
  expect(saved.webSites).toEqual([{ origin: 'https://example.com', visits: 2 }])
  await recordBotSites(paths, bot.id, Array.from({ length: 20 }, (_, i) => `https://site${i}.example`))
  expect((await loadBots(paths))[0]!.webSites).toHaveLength(8)
})

describe('bots — named colleagues with charters and their own conversations', () => {
  it('created, listed, deleted', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-crud'), { git: false })
    const bot = await createBot(paths, { name: 'Release keeper', purpose: 'Tracks release decisions.' })
    expect((await loadBots(paths)).map((b) => b.name)).toEqual(['Release keeper'])
    await deleteBot(paths, bot.id)
    expect(await loadBots(paths)).toEqual([])
  })

  it('a bot needs a name and nothing more; its first words can name it later', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-purpose'), { git: false })
    await expect(createBot(paths, { name: '   ' })).rejects.toThrow(/name/)
    const bot = await createBot(paths, { name: UNTITLED_BOT_NAME })
    expect(bot.purpose).toBe('')
    await renameBot(paths, bot.id, titleFromMessage('  What is our   deploy procedure, and who signs it off every Thursday?  '))
    const named = (await loadBots(paths)).find((b) => b.id === bot.id)?.name ?? ''
    expect(named.startsWith('What is our deploy procedure, and who')).toBe(true)
    expect(named.length).toBeLessThanOrEqual(41)
    expect(named.endsWith('…')).toBe(true)
    expect(titleFromMessage('   ')).toBe(UNTITLED_BOT_NAME)
  })

  it('the conversation persists in order and survives a corrupt line', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-chat'), { git: false })
    const bot = await createBot(paths, { name: 'A', purpose: 'p' })
    await appendBotTurn(paths, bot.id, { role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z' })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'hi', at: '2026-01-01T00:00:01Z' })
    const turns = await readBotTranscript(paths, bot.id)
    expect(turns.map((t) => t.text)).toEqual(['hello', 'hi'])
  })

  it('the transcript is capped — old turns fall off the top', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-cap'), { git: false })
    const bot = await createBot(paths, { name: 'A', purpose: 'p' })
    for (let n = 0; n < 405; n++)
      await appendBotTurn(paths, bot.id, { role: 'user', text: `t${n}`, at: '2026-01-01T00:00:00Z' })
    const turns = await readBotTranscript(paths, bot.id)
    expect(turns).toHaveLength(400)
    expect(turns[0]!.text).toBe('t5')
  })

  it('recommendations grow from the folders the user actually works in', () => {
    const notes = [
      ...Array.from({ length: 6 }, (_, i) => ({ context: 'deploys', title: `d${i}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ context: 'hiring', title: `h${i}` })),
      { title: 'loose note' },
    ]
    const recs = recommendBots(notes, [])
    expect(recs.map((r) => r.name)).toEqual(['deploys assistant', 'hiring assistant', 'Research scout'])
    expect(recs[0]!.reason).toContain('6 memories')
  })

  it('never recommends a bot the user already has', () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({ context: 'deploys', title: `d${i}` }))
    const recs = recommendBots(notes, ['Deploys assistant', 'Research scout'])
    expect(recs).toEqual([])
  })

  it('a turned-down suggestion stays down — through later bot edits and regardless of case', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-dismiss'), { git: false })
    await dismissBotSuggestion(paths, 'Research Scout')
    await dismissBotSuggestion(paths, 'research scout')
    await createBot(paths, { name: 'Release keeper', purpose: 'Tracks release decisions.' })
    expect(await loadDismissedSuggestions(paths)).toEqual(['research scout'])
    const notes = Array.from({ length: 6 }, (_, i) => ({ context: 'deploys', title: `d${i}` }))
    const recs = recommendBots(notes, ['Release keeper'], await loadDismissedSuggestions(paths))
    expect(recs.map((r) => r.name)).toEqual(['deploys assistant'])
  })
})

describe('two changes arriving together', () => {
  it('keeps both tasks: the read-modify-write runs inside the queue', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-race'), { git: false })
    const a = await createBot(paths, { name: 'alpha', purpose: 'x' })
    const b = await createBot(paths, { name: 'beta', purpose: 'y' })
    await Promise.all([
      addBotTask(paths, a.id, { name: 'one', goal: 'do one' }),
      addBotTask(paths, b.id, { name: 'two', goal: 'do two' }),
    ])
    const bots = await loadBots(paths)
    expect(bots.find((x) => x.id === a.id)?.tasks).toHaveLength(1)
    expect(bots.find((x) => x.id === b.id)?.tasks).toHaveLength(1)
  })
})

describe('bots.json that cannot be read', () => {
  const copies = async (cache: string) => (await readdir(cache)).filter(n => n.startsWith('bots.json.corrupt-') && !n.endsWith('.tmp'))

  it('corrupt bots.json is never overwritten', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-corrupt'), { git: false })
    const file = join(paths.cache, 'bots.json')
    await mkdir(paths.cache, { recursive: true })
    await writeFile(file, '{"bots": [')
    const original = await readFile(file)
    const before = await readdir(paths.cache)
    expect(await loadBots(paths)).toEqual([])
    expect(await loadDismissedSuggestions(paths)).toEqual([])
    expect(await readdir(paths.cache)).toEqual(before)
    for (const call of [
      () => createBot(paths, { name: 'A' }),
      () => renameBot(paths, 'x', 'y'),
      () => deleteBot(paths, 'x'),
      () => addBotTask(paths, 'x', { name: 't', goal: 'g' }),
      () => declineStanding(paths, 'x', 'k'),
      () => dismissBotSuggestion(paths, 'z'),
      () => recordBotSites(paths, 'x', ['https://a.example']),
      () => updateBot(paths, 'x', { label: 'l' }),
    ]) await expect(call()).rejects.toThrow(/bots\.json/)
    expect(await readFile(file)).toEqual(original)
    for (const body of ['null', '[]', '{"bots":{}}', '{"bots":[],"dismissed":"x"}']) {
      await writeFile(file, body)
      await expect(createBot(paths, { name: 'A' })).rejects.toThrow(/bots\.json/)
      expect(await readFile(file, 'utf8')).toBe(body)
    }
  })

  it('invalid utf-8 bots.json is treated as corrupt', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-utf8'), { git: false })
    const file = join(paths.cache, 'bots.json')
    const original = Buffer.concat([Buffer.from('{"bots":[{"id":"b","name":"'), Buffer.from([0xff]), Buffer.from('"}]}')])
    await mkdir(paths.cache, { recursive: true })
    await writeFile(file, original)
    await expect(createBot(paths, { name: 'A' })).rejects.toThrow(/bots\.json/)
    await expect(dismissBotSuggestion(paths, 'z')).rejects.toThrow(/bots\.json/)
    const after = await readFile(file)
    expect(after).toEqual(original)
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
    const kept = await copies(paths.cache)
    expect(kept).toHaveLength(1)
    expect(await readFile(join(paths.cache, kept[0]!))).toEqual(original)
  })

  it('corrupt copy kept', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-corrupt-copy'), { git: false })
    const file = join(paths.cache, 'bots.json')
    const stamp = new Date('2025-01-01T00:00:00Z')
    await mkdir(paths.cache, { recursive: true })
    await writeFile(file, '{bad-one')
    await utimes(file, stamp, stamp)
    const first = await createBot(paths, { name: 'A' }).catch((error: Error) => error.message)
    expect(await copies(paths.cache)).toHaveLength(1)
    const [one] = await copies(paths.cache)
    expect(await readFile(join(paths.cache, one!), 'utf8')).toBe('{bad-one')
    expect(first).toContain(join(paths.cache, one!))
    const copyPath = join(paths.cache, one!)
    const old = new Date('2000-01-01T00:00:00Z')
    await utimes(copyPath, old, old)
    const before = await stat(copyPath)
    await expect(createBot(paths, { name: 'A' })).rejects.toThrow()
    await expect(dismissBotSuggestion(paths, 'z')).rejects.toThrow()
    expect(await copies(paths.cache)).toHaveLength(1)
    const after = await stat(copyPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect((await readdir(paths.cache)).filter(n => n.endsWith('.tmp'))).toEqual([])
    await writeFile(copyPath, 'edited')
    await expect(createBot(paths, { name: 'A' })).rejects.toThrow()
    expect(await readFile(copyPath, 'utf8')).toBe('{bad-one')
    const settled = await Promise.allSettled([createBot(paths, { name: 'C' }), createBot(paths, { name: 'D' }), dismissBotSuggestion(paths, 'y')])
    expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(await copies(paths.cache)).toEqual([one])
    expect(await readFile(file, 'utf8')).toBe('{bad-one')
    await writeFile(file, '{bad-two')
    await utimes(file, stamp, stamp)
    const second = await createBot(paths, { name: 'B' }).catch((error: Error) => error.message)
    const names = await copies(paths.cache)
    expect(names).toHaveLength(2)
    const two = names.find(n => n !== one)!
    expect(await readFile(join(paths.cache, two), 'utf8')).toBe('{bad-two')
    expect(second).toContain(join(paths.cache, two))
    expect(await readFile(file, 'utf8')).toBe('{bad-two')
  })

  it('unknown and malformed entries survive a write', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-unknown'), { git: false })
    const file = join(paths.cache, 'bots.json')
    const malformed = [{ name: 'no id', keep: true }, 'stray', null]
    await mkdir(paths.cache, { recursive: true })
    await writeFile(file, JSON.stringify({ version: 7, extra: { a: 1 }, bots: [...malformed, { id: 'bot-a', name: 'A', purpose: '', createdAt: 't', future: { deep: [1] } }], dismissed: ['x', 42] }))
    const read = async () => JSON.parse(await readFile(file, 'utf8'))
    await createBot(paths, { name: 'B' })
    await renameBot(paths, 'bot-a', 'A2')
    let stored = await read()
    expect(stored.version).toBe(7)
    expect(stored.extra).toEqual({ a: 1 })
    expect(stored.bots.slice(0, 3)).toEqual(malformed)
    expect(stored.bots[3]).toMatchObject({ name: 'A2', future: { deep: [1] } })
    expect(stored.bots[4].name).toBe('B')
    expect(stored.dismissed).toEqual(['x', 42])
    await dismissBotSuggestion(paths, 'y')
    stored = await read()
    expect(stored.dismissed).toEqual(['x', 42, 'y'])
    expect(stored.bots).toHaveLength(5)
    await deleteBot(paths, 'bot-a')
    stored = await read()
    expect(stored.bots.slice(0, 3)).toEqual(malformed)
    expect(stored.bots.slice(3).map((b: { name: string }) => b.name)).toEqual(['B'])
    expect((await loadBots(paths)).map(b => b.name)).toEqual(['B'])
  })

  it('missing bots.json still reads as empty', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-missing'), { git: false })
    const file = join(paths.cache, 'bots.json')
    expect(await loadBots(paths)).toEqual([])
    expect(await loadDismissedSuggestions(paths)).toEqual([])
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await dismissBotSuggestion(paths, 'first')
    await createBot(paths, { name: 'A' })
    expect(await loadBots(paths)).toHaveLength(1)
    expect(await loadDismissedSuggestions(paths)).toEqual(['first'])
    expect(await copies(paths.cache)).toEqual([])
  })
})

describe('bot v2 fields', () => {
  const setup = async (tag: string) => {
    const paths = await initVault(await tmpVaultRoot(tag), { git: false })
    const file = join(paths.cache, 'bots.json')
    const bytes = () => readFile(file)
    const stored = async () => JSON.parse(await readFile(file, 'utf8')) as { bots: Record<string, unknown>[] }
    const primaries = async () => (await loadBots(paths)).filter(b => b.primary === true).map(b => b.name)
    return { paths, file, bytes, stored, primaries }
  }

  it('updateBot validates label, notify, and avatar ranges body 0-5 face 0-5 accessory 0-8 palette 0-7 or image', async () => {
    const { paths, bytes, stored } = await setup('bots-v2-validate')
    const bot = await createBot(paths, { name: 'A' })
    expect(FIELD_RANGES).toBe(AVATAR_RANGES)
    expect(AVATAR_RANGES).toEqual({ body: 5, face: 5, accessory: 8, palette: 7 })
    expect(isBotAvatar({ image: '' })).toBe(true)
    expect(botPatchError({ avatar: { image: '' } })).toBeUndefined()
    expect(botPatchError({ label: '😀'.repeat(40) })).toBeUndefined()
    const sparse: string[] = ['a']
    sparse[2] = 'c'
    const bad: unknown[] = [
      { label: 'x'.repeat(41) }, { label: '😀'.repeat(41) }, { notify: 'loud' },
      { avatar: { body: 6, face: 0, accessory: 0, palette: 0 } }, { avatar: { body: 0, face: -1, accessory: 0, palette: 0 } },
      { avatar: { body: 0, face: 0, accessory: 9, palette: 0 } }, { avatar: { body: 0, face: 0, accessory: 0, palette: 8 } },
      { avatar: { body: 1.5, face: 0, accessory: 0, palette: 0 } }, { avatar: { image: 'a', body: 0, face: 0, accessory: 0, palette: 0 } },
      { avatar: { body: 0, face: 0, accessory: 0 } }, { avatar: null }, { label: 3 }, { hidden: false }, { primary: 'yes' },
      { skills: sparse }, { skills: ['a', 1] }, { templateId: 2 },
      { id: 'other' }, { tasks: [] }, { createdAt: 'x' }, { name: '  ' }, { purpose: 4 }, { wings: 2 }, [], null,
    ]
    const before = await bytes()
    for (const patch of bad) await expect(updateBot(paths, bot.id, patch as never)).rejects.toThrow()
    await expect(updateBot(paths, 'missing', { label: 'ok' })).rejects.toThrow(/no such comet/)
    expect(await bytes()).toEqual(before)
    for (const avatar of [{ body: 0, face: 0, accessory: 0, palette: 0 }, { image: '' }, { body: 5, face: 5, accessory: 8, palette: 7 }])
      expect((await updateBot(paths, bot.id, { avatar })).avatar).toEqual(avatar)
    await updateBot(paths, bot.id, { label: '😀'.repeat(40), notify: 'attention', hidden: true, skills: ['', 'b'], templateId: '' })
    await updateBot(paths, bot.id, { notify: 'off' })
    let saved = (await stored()).bots[0]!
    expect(saved).toMatchObject({ name: 'A', label: '😀'.repeat(40), notify: 'off', hidden: true, skills: ['', 'b'], templateId: '', avatar: { body: 5, face: 5, accessory: 8, palette: 7 }, primary: true })
    await updateBot(paths, bot.id, { label: undefined, hidden: undefined, skills: undefined, avatar: undefined })
    saved = (await stored()).bots[0]!
    for (const key of ['label', 'hidden', 'skills', 'avatar']) expect(Object.hasOwn(saved, key)).toBe(false)
    expect(saved.notify).toBe('off')
  })

  it('purpose cap 2000', async () => {
    const { paths, stored } = await setup('bots-v2-purpose')
    const long = 'p'.repeat(1999) + 'q' + 'r'.repeat(500)
    const bot = await createBot(paths, { name: 'A', purpose: long })
    expect((await stored()).bots[0]!.purpose).toBe(long.slice(0, 2000))
    await updateBot(paths, bot.id, { purpose: 'x' + long })
    expect((await stored()).bots[0]!.purpose).toBe(('x' + long).slice(0, 2000))
    expect((await addBotTask(paths, bot.id, { name: 't', goal: 'g'.repeat(600) })).goal).toHaveLength(500)
  })

  it('exactly one primary', async () => {
    const { paths, file, bytes, stored, primaries } = await setup('bots-v2-primary')
    await mkdir(paths.cache, { recursive: true })
    await writeFile(file, JSON.stringify({ extra: 1, bots: [{ name: 'malformed' }], dismissed: [] }))
    const a = await createBot(paths, { name: 'A' })
    expect(a.primary).toBe(true)
    const b = await createBot(paths, { name: 'B' })
    expect(b.primary).toBeUndefined()
    const c = await createBot(paths, { name: 'C' })
    expect(await primaries()).toEqual(['A'])
    await updateBot(paths, b.id, { primary: true })
    expect(await primaries()).toEqual(['B'])
    const before = await bytes()
    await expect(updateBot(paths, b.id, { primary: false })).rejects.toThrow()
    await expect(updateBot(paths, b.id, { primary: undefined })).rejects.toThrow()
    expect(await bytes()).toEqual(before)
    await updateBot(paths, a.id, { primary: false })
    expect(await primaries()).toEqual(['B'])
    await deleteBot(paths, b.id)
    expect(await primaries()).toEqual(['A'])
    await deleteBot(paths, c.id)
    expect(await primaries()).toEqual(['A'])
    await deleteBot(paths, a.id)
    const left = await stored()
    expect(left).toMatchObject({ extra: 1, bots: [{ name: 'malformed' }] })
    expect(await loadBots(paths)).toEqual([])

    const fresh = await setup('bots-v2-primary-race')
    const [x, y, z] = [await createBot(fresh.paths, { name: 'X' }), await createBot(fresh.paths, { name: 'Y' }), await createBot(fresh.paths, { name: 'Z' })]
    await Promise.all([updateBot(fresh.paths, y.id, { primary: true }), updateBot(fresh.paths, z.id, { primary: true })])
    expect(await fresh.primaries()).toEqual(['Z'])
    expect(x.primary).toBe(true)
  })

  it('updateBot reads the patch once', async () => {
    const { paths, bytes, primaries, stored } = await setup('bots-v2-once')
    const a = await createBot(paths, { name: 'A' })
    const b = await createBot(paths, { name: 'B' })
    let primaryReads = 0
    const flip = { get primary() { return primaryReads++ === 0 ? true : undefined } }
    await updateBot(paths, b.id, flip)
    expect(primaryReads).toBe(1)
    expect(await primaries()).toEqual(['B'])
    let labelReads = 0
    const shifty = { get label() { return labelReads++ === 0 ? 'fine' : 'x'.repeat(41) } }
    const before = await bytes()
    const outcome = await updateBot(paths, a.id, shifty).then(() => 'stored', () => 'rejected')
    expect(labelReads).toBe(1)
    const label = (await stored()).bots.find(bot => bot.id === a.id)!.label
    if (outcome === 'rejected') expect(await bytes()).toEqual(before)
    else expect(label).toBe('fine')
    expect(label).not.toBe('x'.repeat(41))
  })

  it('updatedAt is stamped, not patched', async () => {
    const { paths, bytes, stored } = await setup('bots-v2-stamp')
    const bot = await createBot(paths, { name: 'A' }, new Date('2020-05-05T00:00:00.000Z'))
    const created = (await stored()).bots[0]!.updatedAt as string
    expect(new Date(created).toISOString()).toBe(created)
    expect(bot.updatedAt).toBe(created)
    await new Promise(resolve => setTimeout(resolve, 5))
    const updated = await updateBot(paths, bot.id, { label: 'l' })
    const stamped = (await stored()).bots[0]!.updatedAt as string
    expect(new Date(stamped).toISOString()).toBe(stamped)
    expect(updated.updatedAt).toBe(stamped)
    expect(stamped > created).toBe(true)
    const before = await bytes()
    await expect(updateBot(paths, bot.id, { updatedAt: '2020-01-01T00:00:00.000Z' } as never)).rejects.toThrow(/updatedAt/)
    await expect(updateBot(paths, bot.id, { label: 'x'.repeat(41) })).rejects.toThrow()
    expect(await bytes()).toEqual(before)
    expect((await stored()).bots[0]!.updatedAt).toBe(stamped)
  })
})
