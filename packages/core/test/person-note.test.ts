import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadBotMemory, PERSON_MEMORY, recordFacts } from '../src/bot-memory.js'
import { PROFILE_NOTE_ID, profileLines, syncPersonNote } from '../src/person-note.js'
import type { VaultPaths } from '../src/vault.js'

async function tempPaths(): Promise<VaultPaths> {
  const root = await mkdtemp(join(tmpdir(), 'engram-person-note-'))
  const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
  await mkdir(paths.notes, { recursive: true })
  return paths
}
const T1 = new Date('2026-09-01T09:00:00Z'), T2 = new Date('2026-09-02T09:00:00Z'), T3 = new Date('2026-09-03T09:00:00Z')

it('shows the shared profile as a note and takes the person\'s edits back', async () => {
  const paths = await tempPaths()
  await syncPersonNote(paths, T1)
  await expect(readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).rejects.toThrow()
  await recordFacts(paths, PERSON_MEMORY, ['Prefers totals in EUR', 'Works in finance'], T1)
  await syncPersonNote(paths, T1)
  const file = join(paths.notes, `${PROFILE_NOTE_ID}.md`)
  const written = await readFile(file, 'utf8')
  expect(written).toContain('type: profile')
  expect(profileLines(written)).toEqual(['Prefers totals in EUR', 'Works in finance'])
  // The person deletes one line and adds another; a comet learns a third after the note was written.
  await writeFile(file, written.replace('- Works in finance\n', '- Wants dates as YYYY-MM-DD\n'))
  await recordFacts(paths, PERSON_MEMORY, ['Reviews invoices on Mondays'], T3)
  await syncPersonNote(paths, T2)
  const facts = (await loadBotMemory(paths, PERSON_MEMORY)).facts.map((f) => f.text).sort()
  expect(facts).toEqual(['Prefers totals in EUR', 'Reviews invoices on Mondays', 'Wants dates as YYYY-MM-DD'])
  expect(profileLines(await readFile(file, 'utf8')).sort()).toEqual(facts)
})

it('forgets old per-comet copies, preserves prose, and does not resurrect a forgotten note line', async () => {
  const paths = await tempPaths()
  await recordFacts(paths, 'bot-a', ['Works in finance'], T1)
  await syncPersonNote(paths, T1, ['Works in finance'])
  const file = join(paths.notes, `${PROFILE_NOTE_ID}.md`)
  const written = await readFile(file, 'utf8')
  await writeFile(file, written + '\nMy own paragraph.\n')
  await syncPersonNote(paths, T2, [], ['Works in finance'])
  await syncPersonNote(paths, T3)
  expect((await loadBotMemory(paths, PERSON_MEMORY)).facts).toEqual([])
  expect((await loadBotMemory(paths, 'bot-a')).facts).toEqual([])
  const body = await readFile(file, 'utf8')
  expect(body).toContain('My own paragraph.')
  expect(body).not.toContain('- Works in finance')
})

it('serializes concurrent shared learning without dropping either new fact', async () => {
  const paths = await tempPaths()
  await Promise.all([syncPersonNote(paths, T1, ['Prefers totals in EUR']), syncPersonNote(paths, T1, ['Reviews invoices on Mondays'])])
  const facts = (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(f => f.text).sort()
  expect(facts).toEqual(['Prefers totals in EUR', 'Reviews invoices on Mondays'])
  expect(profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).sort()).toEqual(facts)
})
