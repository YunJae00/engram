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

it('qa146: a corrected value replaces the old line in the note, and a polluted note is cleaned on the next write', async () => {
  const paths = await tempPaths()
  const file = join(paths.notes, `${PROFILE_NOTE_ID}.md`)
  await syncPersonNote(paths, T1, ['출시 제품의 코드명은 "북극성"이다', '사용자의 팀 이름은 은하수입니다', '11월 28일 출시 목표인 프로젝트를 진행 중'])
  expect(profileLines(await readFile(file, 'utf8'))).toContain('11월 28일 출시 목표인 프로젝트를 진행 중')
  // What keep_in_mind wrote on v0.8.146: the new value with the old one named beside it.
  await syncPersonNote(paths, T2, ['프로젝트 코드명은 "은하호"입니다(2026-11-16 사용자가 지정, 이전에 쓰던 "북극성"을 대체)', '출시일은 12월 5일입니다(이전 11월 28일을 대체)'])
  const clean = ['사용자의 팀 이름은 은하수입니다', '프로젝트 코드명은 "은하호"입니다', '출시일은 12월 5일입니다']
  expect(profileLines(await readFile(file, 'utf8'))).toEqual(clean)
  expect((await loadBotMemory(paths, PERSON_MEMORY)).facts.map((f) => f.text)).toEqual(clean)
  // Residue already published by the old version leaves the note and does not come back.
  const body = await readFile(file, 'utf8')
  await writeFile(file, `${body.trimEnd()}\n- 정식 팀 이름은 은하수이고, 이전 초안에 적힌 "TeStCode"는 오타이물로 사용하지 않습니다\n- 기존 보고서에는 아직 11월 28일(이전 출시 목표)이 기록되어 있어요\n`)
  await syncPersonNote(paths, T3)
  await syncPersonNote(paths, T3)
  const after = await readFile(file, 'utf8')
  expect(after).not.toMatch(/TeStCode|11월 28일|북극성/)
  expect(profileLines(after)).toEqual([...clean, '정식 팀 이름은 은하수이다'])
})
