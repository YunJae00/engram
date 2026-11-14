import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { loadBotMemory, mergeMemory, PERSON_MEMORY, PROFILE_NOTE_ID, profileLines, recordFacts, renderMemory, syncPersonNote, type Engine, type VaultPaths } from 'core'
vi.mock('core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('core')>()
  return { ...actual, syncPersonNote: vi.fn(actual.syncPersonNote) }
})
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { registerCometMemoryIpc, rememberTurn } from '../src/main/comet-memory.js'
import { learningTools } from '../src/main/learning-wiring.js'

async function tempPaths(): Promise<VaultPaths> {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/comet-scope-'))
  const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
  await mkdir(paths.notes, { recursive: true })
  return paths
}
const engineSaying = (text: string) => ({ id: 'claude', async *run() { yield { type: 'result', text } } }) as unknown as Engine
const remember = (paths: VaultPaths, text: string) => rememberTurn({ engine: engineSaying(text), workdir: paths.workspace as never, paths, botId: 'atlas', channel: 'bot-atlas', message: '배포 절차가 어떻게 되나요?', answer: '목요일 오후입니다.' })
const texts = async (paths: VaultPaths, id: string) => (await loadBotMemory(paths, id)).facts.map((f) => f.text)
const noteLines = async (paths: VaultPaths) => profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8'))
const KOREAN = ['보고서는 표로 받는 걸 좋아한다', '결정: 배포는 목요일 오후에만 한다', '진행 중인 프로젝트: Falcon 이전, 12월 말 완료 목표']
beforeEach(() => { vi.mocked(syncPersonNote).mockClear() })

it('Korean facts marked everyone are shared and read by a different bot', async () => {
  const paths = await tempPaths()
  await remember(paths, KOREAN.map((line) => `- everyone: ${line}`).join('\n'))
  expect(await texts(paths, PERSON_MEMORY)).toEqual(KOREAN)
  expect(await texts(paths, 'atlas')).toEqual([])
  expect(vi.mocked(syncPersonNote).mock.calls[0]![2]).toEqual(KOREAN)
  const nova = renderMemory(mergeMemory(await loadBotMemory(paths, PERSON_MEMORY), await loadBotMemory(paths, 'nova')))
  for (const line of KOREAN) expect(nova).toContain(line)
})

it('this bot facts stay per-bot', async () => {
  const paths = await tempPaths()
  await remember(paths, '- this bot: 사내 포털 주소는 https://portal.example/ 이다')
  expect(await texts(paths, 'atlas')).toEqual(['사내 포털 주소는 https://portal.example/ 이다'])
  expect(await texts(paths, PERSON_MEMORY)).toEqual([])
  expect(syncPersonNote).not.toHaveBeenCalled()
})

it('an unmarked Korean identity fact is shared through the fallback', async () => {
  const paths = await tempPaths()
  await remember(paths, '- 이름은 윤재라고 불러 달라고 했다')
  expect(await texts(paths, PERSON_MEMORY)).toEqual(['이름은 윤재라고 불러 달라고 했다'])
  expect(await texts(paths, 'atlas')).toEqual([])
})

it('keep_in_mind shares by default and keeps this bot facts in the bot file', async () => {
  const paths = await tempPaths()
  const keep = learningTools(paths, 'bot-atlas', () => '').find((tool) => tool.name === 'keep_in_mind')!
  await keep.run({ facts: ['결정: 회의록은 금요일에 보낸다'] }, { task: '' })
  expect(await texts(paths, PERSON_MEMORY)).toEqual(['결정: 회의록은 금요일에 보낸다'])
  expect(await noteLines(paths)).toContain('결정: 회의록은 금요일에 보낸다')
  await keep.run({ facts: ['이 봇의 점검 사이트는 status.example 이다'], scope: 'this bot' }, { task: '' })
  expect(await texts(paths, 'atlas')).toEqual(['이 봇의 점검 사이트는 status.example 이다'])
  expect(await texts(paths, PERSON_MEMORY)).toEqual(['결정: 회의록은 금요일에 보낸다'])
})

it('forgetting a shared fact removes it from both layers and the profile note', async () => {
  const paths = await tempPaths()
  vi.mocked(ipcMain.handle).mockClear()
  registerCometMemoryIpc(paths)
  const forget = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'bots:memoryForget')![1]
  await remember(paths, `- everyone: ${KOREAN[0]}`)
  await recordFacts(paths, 'atlas', [KOREAN[0]!])
  expect(await noteLines(paths)).toContain(KOREAN[0])
  const id = mergeMemory(await loadBotMemory(paths, PERSON_MEMORY), await loadBotMemory(paths, 'atlas')).facts.find((f) => f.text === KOREAN[0])!.id
  await forget({} as never, 'atlas', id)
  expect(await texts(paths, PERSON_MEMORY)).toEqual([])
  expect(await texts(paths, 'atlas')).toEqual([])
  expect(await noteLines(paths)).not.toContain(KOREAN[0])
})
