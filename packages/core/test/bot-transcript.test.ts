import { expect, it } from 'vitest'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBotTranscript, type BotTurn } from '../src/bots.js'
import { readArchivedTranscript, readBotTranscriptPage } from '../src/bot-transcript.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const turn = (i: number, extra: Partial<BotTurn> = {}) => JSON.stringify({ role: i % 2 ? 'user' : 'assistant', text: `t${i}`, at: '2026-11-01', ...extra })
const range = (from: number, to: number) => {
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`t${i}`)
  return out
}
const texts = (rows: BotTurn[]) => rows.map(row => row.text)

async function vault(name: string): Promise<{ paths: VaultPaths; dir: string }> {
  const paths = await initVault(await tmpVaultRoot(name), { git: false })
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  return { paths, dir }
}

it('before cursor returns older page', async () => {
  const { paths, dir } = await vault('page-before')
  const lines: string[] = []
  for (let i = 1; i <= 30; i++) {
    lines.push(turn(i, i === 7 ? { progress: true } : {}))
    if (i === 5 || i === 18) lines.push('')
    if (i === 12) lines.push('{broken')
    if (i === 22) lines.push(JSON.stringify({ role: 'system', text: 'sys', at: '2026-11-01' }))
  }
  await writeFile(join(dir, 'b.jsonl'), `${lines.join('\n')}\n`)
  expect(texts(await readBotTranscriptPage(paths, 'b', 10, 10))).toEqual(range(11, 20))
  expect(texts(await readBotTranscriptPage(paths, 'b', 0, 10))).toEqual(range(21, 30))
  const oldest = await readBotTranscriptPage(paths, 'b', 25, 10)
  expect(texts(oldest)).toEqual(range(1, 5))
  expect(texts(await readBotTranscriptPage(paths, 'b', 20, 10))).toEqual(range(1, 10))
  expect((await readBotTranscriptPage(paths, 'b', 20, 10))[6]?.progress).toBe(true)
  expect(await readBotTranscriptPage(paths, 'b', 30, 10)).toEqual([])
  expect(await readBotTranscriptPage(paths, 'nobody', 0, 10)).toEqual([])
})

it('turns beyond 400 reachable', async () => {
  const { paths, dir } = await vault('page-beyond')
  const lines: string[] = []
  for (let i = 1; i <= 450; i++) lines.push(turn(i))
  const file = join(dir, 'b.jsonl')
  await writeFile(file, `${lines.join('\n')}\n`)
  expect(texts(await readBotTranscript(paths, 'b'))).toEqual(range(51, 450))
  expect(texts(await readBotTranscriptPage(paths, 'b', 0, 400))).toEqual(range(51, 450))
  expect(texts(await readBotTranscriptPage(paths, 'b', 400, 400))).toEqual(range(1, 50))
  expect(await readBotTranscriptPage(paths, 'b', 450, 400)).toEqual([])
  const held = await readBotTranscriptPage(paths, 'b', 0, 10)
  await appendFile(file, `${turn(451)}\n`)
  expect(texts(await readBotTranscriptPage(paths, 'b', held.length + 1, 10))).toEqual(range(431, 440))
})

it('archived transcript read by stamp, path-like stamp rejected', async () => {
  const { paths, dir } = await vault('page-archive')
  const stamp = '2026-11-01T09-00-00'
  await writeFile(join(dir, `b.${stamp}.jsonl`), [turn(1), '', '{broken', turn(2, { progress: true }), turn(3)].join('\n'))
  expect(texts(await readArchivedTranscript(paths, 'b', stamp))).toEqual(range(1, 3))
  expect(texts(await readArchivedTranscript(paths, 'b', stamp, 1, 1))).toEqual(['t2'])
  const [newer, older] = await Promise.all([readArchivedTranscript(paths, 'b', stamp, 0, 2), readArchivedTranscript(paths, 'b', stamp, 2, 2)])
  expect(texts(newer)).toEqual(['t2', 't3'])
  expect(texts(older)).toEqual(['t1'])
  const reopened = await initVault(paths.root, { git: false })
  expect(texts(await readArchivedTranscript(reopened, 'b', stamp))).toEqual(range(1, 3))

  await writeFile(join(paths.cache, 'x.jsonl'), `${turn(1)}\n`)
  await writeFile(join(dir, 'b.jsonl'), `${turn(1)}\n`)
  const stamps = ['/../../x', '../x', 'a/b', 'a\\b', '', ' 2026-11-01T09-00-00', '2026-11-01T09:00:00', '2026-11-01T09-00-00.jsonl', join(dir, 'b'), 7, null]
  for (const bad of stamps) await expect(readArchivedTranscript(paths, 'b', bad)).rejects.toThrow(/stamp/)
  for (const id of ['../b', 'a/b', '', 'b.2026', 3, undefined]) {
    await expect(readArchivedTranscript(paths, id, stamp)).rejects.toThrow(/comet/)
    await expect(readBotTranscriptPage(paths, id, 0)).rejects.toThrow(/comet/)
  }
  const nowhere = { ...paths, cache: join(paths.root, 'missing', 'cache') }
  await expect(readArchivedTranscript(nowhere, 'b', '../x')).rejects.toThrow(/stamp/)
  await expect(readArchivedTranscript(paths, 'b', '2026-11-02T09-00-00')).rejects.toThrow(/no such conversation/)
  await mkdir(join(dir, 'b.2026-11-03T09-00-00.jsonl'))
  await expect(readArchivedTranscript(paths, 'b', '2026-11-03T09-00-00')).rejects.toThrow(/EISDIR/)
})

it('page arguments are validated', async () => {
  const { paths, dir } = await vault('page-args')
  const stamp = '2026-11-01T09-00-00'
  const lines: string[] = []
  for (let i = 1; i <= 450; i++) lines.push(turn(i))
  await writeFile(join(dir, 'b.jsonl'), `${lines.join('\n')}\n`)
  await writeFile(join(dir, `b.${stamp}.jsonl`), `${lines.join('\n')}\n`)
  for (const before of [-1, 1.5, NaN, '3', null, 2 ** 53]) {
    await expect(readBotTranscriptPage(paths, 'b', before)).rejects.toThrow(/page/)
    await expect(readArchivedTranscript(paths, 'b', stamp, before)).rejects.toThrow(/page/)
  }
  await expect(readBotTranscriptPage(paths, 'b', undefined)).rejects.toThrow(/page/)
  for (const limit of [0, 401, 2.5, '10']) {
    await expect(readBotTranscriptPage(paths, 'b', 0, limit)).rejects.toThrow(/page/)
    await expect(readArchivedTranscript(paths, 'b', stamp, 0, limit)).rejects.toThrow(/page/)
  }
  const nowhere = { ...paths, cache: join(paths.root, 'missing', 'cache') }
  await expect(readBotTranscriptPage(nowhere, 'b', -1)).rejects.toThrow(/page/)
  expect(texts(await readBotTranscriptPage(paths, 'b', 0))).toEqual(range(51, 450))
  expect(texts(await readArchivedTranscript(paths, 'b', stamp))).toEqual(range(51, 450))
  expect(await readBotTranscriptPage(paths, 'b', Number.MAX_SAFE_INTEGER)).toEqual([])
  expect(await readArchivedTranscript(paths, 'b', stamp, Number.MAX_SAFE_INTEGER)).toEqual([])
})
