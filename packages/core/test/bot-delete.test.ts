import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addBotTask, createBot, deleteBot, loadBots, updateBot, type Bot } from '../src/bots.js'
import { deleteSummary } from '../src/bot-delete.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const STAMP = '2026-08-25T09-10-00'

async function writeFacts(paths: VaultPaths, id: string, count: number): Promise<string> {
  const file = join(paths.cache, 'bot-memory', `${id}.json`)
  await mkdir(join(paths.cache, 'bot-memory'), { recursive: true })
  const facts = Array.from({ length: count }, (_, i) => ({ id: `f${i}`, text: `fact ${i}`, at: '2026-08-01T00:00:00.000Z', touchedAt: '2026-08-01T00:00:00.000Z' }))
  await writeFile(file, JSON.stringify({ facts, turns: count }))
  return file
}

async function writeChats(paths: VaultPaths, names: string[]): Promise<string[]> {
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  for (const name of names) await writeFile(join(dir, name), `{"role":"user","text":"${name}","at":"2026-08-25"}\n`)
  return names.map((name) => join(dir, name))
}

const exists = (file: string) => readFile(file).then(() => true, () => false)

describe('deleting a comet', () => {
  it('primary cannot be deleted', async () => {
    const paths = await initVault(await tmpVaultRoot('bot-delete-primary'), { git: false })
    const solo = await createBot(paths, { name: 'Solo' })
    await expect(deleteBot(paths, solo.id)).rejects.toThrow(/primary/)
    expect((await loadBots(paths)).map((b) => b.id)).toEqual([solo.id])

    const fresh = await initVault(await tmpVaultRoot('bot-delete-primary-two'), { git: false })
    const a = await createBot(fresh, { name: 'A' })
    const b = await createBot(fresh, { name: 'B' })
    const memory = await writeFacts(fresh, a.id, 2)
    const freshBots = join(fresh.cache, 'bots.json')
    const [botsBefore, memoryBefore] = [await readFile(freshBots), await readFile(memory)]
    await expect(deleteBot(fresh, a.id)).rejects.toThrow(/primary/)
    expect(await readFile(freshBots)).toEqual(botsBefore)
    expect(await readFile(memory)).toEqual(memoryBefore)
    await updateBot(fresh, b.id, { primary: true })
    await deleteBot(fresh, a.id)
    expect((await loadBots(fresh)).map((x) => x.id)).toEqual([b.id])
    expect(await exists(memory)).toBe(false)

    const raw = await initVault(await tmpVaultRoot('bot-delete-primary-dup'), { git: false })
    const rawBots = join(raw.cache, 'bots.json')
    const row = { name: 'X', purpose: '', createdAt: '2026-08-01T00:00:00.000Z' }
    await writeFile(rawBots, JSON.stringify({ bots: [{ id: 'X', ...row }, { id: 'X', ...row, primary: true }], dismissed: [] }))
    const xMemory = await writeFacts(raw, 'X', 1)
    const [rawBefore, xBefore] = [await readFile(rawBots), await readFile(xMemory)]
    await expect(deleteBot(raw, 'X')).rejects.toThrow(/primary/)
    expect(await readFile(rawBots)).toEqual(rawBefore)
    expect(await readFile(xMemory)).toEqual(xBefore)
    await writeFile(rawBots, JSON.stringify({ bots: [{ id: 'Y', ...row }, { id: 'Y' }, { id: 'Z', ...row, primary: true }], dismissed: [] }))
    await deleteBot(raw, 'Y')
    expect(JSON.parse(await readFile(rawBots, 'utf8')).bots.map((b: { id: string }) => b.id)).toEqual(['Z'])
    const zBefore = await readFile(rawBots)
    await deleteBot(raw, 'unknown')
    expect(await readFile(rawBots)).toEqual(zBefore)
  })

  it('nameless primary stub blocks delete', async () => {
    const paths = await initVault(await tmpVaultRoot('bot-delete-stub'), { git: false })
    const file = join(paths.cache, 'bots.json')
    const valid = { id: 'X', name: 'X', purpose: '', createdAt: '2026-08-01T00:00:00.000Z' }
    await writeFile(file, JSON.stringify({ bots: [valid, { id: 'X', primary: true }], dismissed: [] }))
    const memory = await writeFacts(paths, 'X', 1)
    const [botsBefore, memoryBefore] = [await readFile(file), await readFile(memory)]
    await expect(deleteBot(paths, 'X')).rejects.toThrow(/primary/)
    expect(await readFile(file)).toEqual(botsBefore)
    expect(await readFile(memory)).toEqual(memoryBefore)
    expect((await loadBots(paths)).map((b) => b.id)).toEqual(['X'])
  })

  it('undo create removes only an untouched new bot', async () => {
    const paths = await initVault(await tmpVaultRoot('bot-delete-undo'), { git: false })
    const p = await createBot(paths, { name: 'P' })
    await deleteBot(paths, p.id, { undoCreate: p })
    expect(await loadBots(paths)).toEqual([])

    const botsFile = join(paths.cache, 'bots.json')
    const refused = async (id: string, undoCreate: Bot) => {
      const before = await readFile(botsFile)
      await expect(deleteBot(paths, id, { undoCreate })).rejects.toThrow(/primary/)
      expect(await readFile(botsFile)).toEqual(before)
    }
    const q = await createBot(paths, { name: 'Q' })
    await refused(q.id, { ...q, createdAt: '2020-01-01T00:00:00.000Z' })
    await refused(q.id, { ...q, updatedAt: '2020-01-01T00:00:00.000Z' })
    await updateBot(paths, q.id, { label: 'x' })
    await refused(q.id, q)

    const fresh = await initVault(await tmpVaultRoot('bot-delete-undo-task'), { git: false })
    const r = await createBot(fresh, { name: 'R' })
    await addBotTask(fresh, r.id, { name: 'T', goal: 'g' })
    const freshFile = join(fresh.cache, 'bots.json')
    const before = await readFile(freshFile)
    await expect(deleteBot(fresh, r.id, { undoCreate: r })).rejects.toThrow(/primary/)
    expect(await readFile(freshFile)).toEqual(before)

    const dup = await initVault(await tmpVaultRoot('bot-delete-undo-dup'), { git: false })
    const d = await createBot(dup, { name: 'D' })
    const dupFile = join(dup.cache, 'bots.json')
    await writeFile(dupFile, JSON.stringify({ bots: [d, { ...d, primary: undefined }], dismissed: [] }))
    const dupBefore = await readFile(dupFile)
    await expect(deleteBot(dup, d.id, { undoCreate: d })).rejects.toThrow(/primary/)
    expect(await readFile(dupFile)).toEqual(dupBefore)
  })

  it('delete summary counts routines, facts, archived chats', async () => {
    const paths = await initVault(await tmpVaultRoot('bot-delete-summary'), { git: false })
    const empty = await createBot(paths, { name: 'Empty' })
    const bot = await createBot(paths, { name: 'Busy' })
    const other = await createBot(paths, { name: 'Other' })
    await addBotTask(paths, bot.id, { name: 'One', goal: 'x' })
    await addBotTask(paths, bot.id, { name: 'Two', goal: 'y', routineId: 'rt-1', schedule: { days: [1], hour: 9, minute: 0 } })
    await writeFacts(paths, bot.id, 3)
    await writeChats(paths, [
      `${bot.id}.jsonl`,
      `${bot.id}.${STAMP}.jsonl`,
      `${bot.id}.2026-08-26T10-00-00.jsonl`,
      `${other.id}.${STAMP}.jsonl`,
      `${bot.id}x.${STAMP}.jsonl`,
      `${bot.id}.notes.jsonl`,
    ])
    const botsFile = join(paths.cache, 'bots.json')
    const before = await readFile(botsFile)
    expect(await deleteSummary(paths, bot.id)).toEqual({ routines: 2, facts: 3, archivedChats: 2 })
    expect(await deleteSummary(paths, empty.id)).toEqual({ routines: 0, facts: 0, archivedChats: 0 })
    await expect(deleteSummary(paths, 'missing-comet')).rejects.toThrow(/no such comet/)
    await expect(deleteSummary(paths, '../bots')).rejects.toThrow()
    expect(await readFile(botsFile)).toEqual(before)
    await writeFile(join(paths.cache, 'bot-memory', '_person.json'), JSON.stringify({ facts: [{ id: 'p', text: 'p', at: STAMP, touchedAt: STAMP }], turns: 1 }))
    expect((await deleteSummary(paths, empty.id)).facts).toBe(0)

    const bare = await initVault(await tmpVaultRoot('bot-delete-summary-bare'), { git: false })
    const lone = await createBot(bare, { name: 'Lone' })
    expect(await deleteSummary(bare, lone.id)).toEqual({ routines: 0, facts: 0, archivedChats: 0 })
  })

  it('delete leaves transcript files on disk', async () => {
    const paths = await initVault(await tmpVaultRoot('bot-delete-transcripts'), { git: false })
    await createBot(paths, { name: 'Lead' })
    const bot = await createBot(paths, { name: 'Gone' })
    const memory = await writeFacts(paths, bot.id, 1)
    const files = await writeChats(paths, [`${bot.id}.jsonl`, `${bot.id}.${STAMP}.jsonl`])
    const before = await Promise.all(files.map((file) => readFile(file)))
    await deleteBot(paths, bot.id)
    expect((await loadBots(paths)).map((b) => b.name)).toEqual(['Lead'])
    expect(await exists(memory)).toBe(false)
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before)
  })
})
