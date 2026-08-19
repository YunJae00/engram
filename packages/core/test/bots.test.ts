import { describe, expect, it } from 'vitest'
import { appendBotTurn, createBot, deleteBot, loadBots, readBotTranscript, recommendBots } from '../src/bots.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('bots — named colleagues with charters and their own conversations', () => {
  it('created, listed, deleted', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-crud'), { git: false })
    const bot = await createBot(paths, { name: 'Release keeper', purpose: 'Tracks release decisions.' })
    expect((await loadBots(paths)).map((b) => b.name)).toEqual(['Release keeper'])
    await deleteBot(paths, bot.id)
    expect(await loadBots(paths)).toEqual([])
  })

  it('a bot without a purpose is refused — the charter IS the bot', async () => {
    const paths = await initVault(await tmpVaultRoot('bots-purpose'), { git: false })
    await expect(createBot(paths, { name: 'X', purpose: '   ' })).rejects.toThrow(/purpose/)
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
})
