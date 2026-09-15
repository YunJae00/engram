import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readSessionCursors, writeSessionCursors, type SessionCursor } from '../src/main/session-cursor.js'

const dirs: string[] = []
async function stateFile() {
  const dir = await mkdtemp(resolve('tmp/session-cursor-'))
  dirs.push(dir)
  return join(dir, 'cursors.json')
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('retains every pending turn across restarts and persists successful removal without new input', async () => {
  const file = await stateFile()
  const held = Array.from({ length: 160 }, (_, i) => ({ role: 'assistant' as const, text: `Finding ${i}`, at: '2026-09-15T01:00:00Z' }))
  const original = new Map<string, SessionCursor>([['conversation', { offset: 5000, held, lastGrewAt: 123, kept: ['Earlier finding'] }]])
  await writeSessionCursors(file, original)
  const restarted = (await readSessionCursors(file))!
  expect(restarted).toEqual(original)
  restarted.get('conversation')!.held.splice(0, 40)
  await writeSessionCursors(file, restarted)
  expect((await readSessionCursors(file))!.get('conversation')!.held).toEqual(held.slice(40))
})

it('accepts legacy checkpoints, but never silently resets corrupt existing state', async () => {
  const file = await stateFile()
  expect(await readSessionCursors(file)).toBeNull()
  await writeFile(file, JSON.stringify({ old: { offset: 90, kept: ['Decision'] } }))
  expect((await readSessionCursors(file))!.get('old')).toEqual({ offset: 90, kept: ['Decision'], held: [], lastGrewAt: 0 })
  for (const invalid of ['{', '{"old":{"offset":-1}}', '{"old":{"offset":1,"held":[{}]}}']) {
    await writeFile(file, invalid)
    await expect(readSessionCursors(file)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(invalid)
  }
})
