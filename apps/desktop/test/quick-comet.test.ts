import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appendBotTurn, createBot, initVault, loadBots } from 'core'
import { quickCometBounds, quickPrimary } from '../src/main/quick-comet.js'

async function twoBots() {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/quick-primary-')), { git: false })
  const a = await createBot(paths, { name: 'Engram' })
  await createBot(paths, { name: 'Other' })
  return { paths, a, file: join(paths.cache, 'bots.json') }
}

describe('quick Comet placement', () => {
  it('opens beside the pointer', () => {
    expect(quickCometBounds({ x: 100, y: 200 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 116, y: 216, width: 480, height: 88 })
  })
  it('stays inside the pointer monitor, including negative coordinates and taskbar space', () => {
    expect(quickCometBounds({ x: -5, y: 1030 }, { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ x: -492, y: 940, width: 480, height: 88 })
  })
  it('fits smaller displays and clamps pointers outside the work area', () => {
    expect(quickCometBounds({ x: -100, y: -100 }, { x: 0, y: 0, width: 400, height: 180 })).toEqual({ x: 12, y: 12, width: 376, height: 88 })
  })
})

describe('quick Comet primary', () => {
  it('quick:comet sends to primary channel and creates no bot', async () => {
    const { paths, a, file } = await twoBots()
    await appendBotTurn(paths, a.id, { role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' })
    await appendBotTurn(paths, a.id, { role: 'assistant', text: 'hello', at: '2026-01-01T00:00:01Z' })
    await appendBotTurn(paths, a.id, { role: 'assistant', text: 'working', at: '2026-01-01T00:00:02Z', progress: true })
    const before = await readFile(file)
    const r = await quickPrimary(paths, () => false)
    expect(r.bot.id).toBe(a.id)
    expect(r.channel).toBe(`bot-${a.id}`)
    expect(r.history.map(({ role, text, at }) => ({ role, text, at }))).toEqual([
      { role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'hello', at: '2026-01-01T00:00:01Z' },
    ])
    expect(await loadBots(paths)).toHaveLength(2)
    expect((await readFile(file)).equals(before)).toBe(true)
  })
  it('quick:comet refuses a busy primary and a missing primary without writing', async () => {
    const { paths, a, file } = await twoBots()
    const before = await readFile(file)
    await expect(quickPrimary(paths, ch => ch === `bot-${a.id}`)).rejects.toThrow(/^This conversation is still working\. Stop it or wait for it to finish\.$/)
    expect((await readFile(file)).equals(before)).toBe(true)
    const stored = JSON.parse(before.toString('utf8'))
    for (const bot of stored.bots) delete bot.primary
    await writeFile(file, JSON.stringify(stored))
    const unmarked = await readFile(file)
    await expect(quickPrimary(paths, () => false)).rejects.toThrow(/^No primary bot to send to\. Make one bot primary first\.$/)
    expect((await readFile(file)).equals(unmarked)).toBe(true)
  })
})
