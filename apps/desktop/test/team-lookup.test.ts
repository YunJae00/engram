import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createTask, listTasks, LOOKUP_MAX_CALLS, LOOKUP_SOFT_MS, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// perf146: "봇 3개 생성해서 서울 부산 제주 날씨 조사" ran three opus members with 65 tools each for 118-213 s; the lead waited for the slowest.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Seen = { tools: string[]; options: NonNullable<Parameters<Run>[2]> }
const tool = (name: string): AgentTool => ({ name, description: '', argsSchema: {}, run: async () => name })

async function world(script: (seen: Seen) => Promise<Awaited<ReturnType<Run>>>, lookupHardMs?: number) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-lookup-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 알려줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const seen: Seen[] = []
  const run: Run = async (deps, _prompt, options = {}) => { const one = { tools: deps.tools.map(t => t.name), options }; seen.push(one); return script(one) }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(lookupHardMs ? { lookupHardMs } : {}) })
  const nativeFor = vi.fn(async () => ({ cwd: '/task' }) as never)
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor,
    toolsFor: async lane => [...team.tools(lane, kit), ...['search_web', 'read_pages', 'open_page', 'look', 'ask_person', 'page_steps', 'app_click', 'excel_write', 'file_read'].map(tool)] }
  const hire = (members: Record<string, unknown>[]) => team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members }, { task: '' })
  const members = async () => (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  return { hire, members, seen, nativeFor }
}

it('runs a lookup member on the faster tier with reading tools only, no shell and a time box', async () => {
  const w = await world(async () => ({ answer: '서울 맑음 12도 (https://weather.example)', steps: [], fellBack: false }))
  const out = JSON.parse(await w.hire([{ role: '서울 조사', brief: '서울 오늘 날씨', lookup: true }, { role: '보고서', brief: '엑셀로 정리' }]))
  const [lookup, work] = w.seen
  expect(lookup!.tools.sort()).toEqual(['ask_person', 'look', 'open_page', 'read_pages', 'search_web'])
  expect(lookup!.options).toMatchObject({ modelHint: 'smart', maxCalls: LOOKUP_MAX_CALLS, deadlineMs: LOOKUP_SOFT_MS })
  expect(lookup!.options.native).toBeUndefined()
  expect(lookup!.options.persona).toContain('You only look things up')
  // A member that makes something keeps the full set and the work model.
  expect(work!.tools).toEqual(expect.arrayContaining(['excel_write', 'file_read', 'page_steps', 'hire_members']))
  expect(work!.options.modelHint).toBeUndefined()
  expect(work!.options.deadlineMs).toBeUndefined()
  expect(work!.options.native).toBeTruthy()
  expect(w.nativeFor).toHaveBeenCalledTimes(1)
  expect(out.members.map((m: { state: string }) => m.state)).toEqual(['done', 'done'])
})

it('hands the lead what a lookup member had when it stops at its call or time limit', async () => {
  const w = await world(async () => ({ answer: 'Not verified as complete.\n\nThe tool-call or time limit was reached.\n\nUnverified response:\n부산 흐림 15도', steps: [], fellBack: false, stopped: 'calls' }))
  const out = JSON.parse(await w.hire([{ role: '부산 조사', brief: '부산 오늘 날씨', lookup: true }]))
  expect(out.members[0]).toMatchObject({ state: 'done', result: '부산 흐림 15도\n(stopped at its time or call limit: this is what it had)' })
})

it('stops a lookup member at its hard limit and still delivers what it wrote', async () => {
  const w = await world(seen => new Promise((_, reject) => {
    seen.options.onToken?.('thinking aloud'); seen.options.onReset?.(); seen.options.onToken?.('제주 비 17도')
    seen.options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
  }), 30)
  const started = Date.now()
  const out = JSON.parse(await w.hire([{ role: '제주 조사', brief: '제주 오늘 날씨', lookup: true }]))
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(out.members[0]).toMatchObject({ state: 'done', result: '제주 비 17도\n(stopped at its time or call limit: this is what it had)' })
  expect((await w.members())[0]!.state).toBe('done')
})
