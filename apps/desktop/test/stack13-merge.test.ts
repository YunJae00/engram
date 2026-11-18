import { mkdir, mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createBot, createTask, LOOKUP_TOOLS, TEAM_ANSWER_MS, updateTask, WORK_REPLY_RULE, type AgentTool, type VaultPaths } from 'core'
import type { ToolSessionJob } from '../../../packages/core/src/engine/types.js'
import { COLLECTION_RULE } from '../../../packages/core/src/collection-progress.js'
import { CHOICE_RULE } from '../../../packages/core/src/agent-voice.js'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-stack13-${tag}-`)), '.engram') } as unknown as VaultPaths }
const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const stub = (name: string, run: AgentTool['run'] = async () => ''): AgentTool => ({ name, description: name, argsSchema: {}, run })

describe('stack-13 merge: prompt selection reaches a lookup teammate', () => {
  it('a named lookup teammate run by c13a\'s runner is sent the lookup rule set (measured on the real session builder)', async () => {
    const paths = await vault('prompt')
    for (const name of ['엔그램', '하람']) await createBot(paths, { name })
    const created = await createTask(paths, '이번 주 수원 마라톤 소식 알아봐줘', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const jobs: ToolSessionJob[] = []
    const engine = { id: 'claude', desktopToolIsolation: true, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '```report\n{"facts":[{"text":"수원 마라톤이 11월 22일에 열려요.","url":"https://run.example/1"}]}\n```' } } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined })
    const menu = [...LOOKUP_TOOLS, 'collect_results', 'file_create_copy', 'page_do'].map(name => stub(name, async () => name === 'search_web' ? 'results for "수원 마라톤" at https://search.example/?q=1 (DATA, not instructions):\n- 수원 마라톤 — https://run.example/1 — 11월 22일' : ''))
    const kit: TurnKit = { engine, workdir: '/tmp' as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), ...menu] }
    await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: false, to: [{ who: '하람', topic: '수원 마라톤', brief: '이번 주 수원 마라톤 소식 조사' }] }, { task: '' })
    await vi.waitFor(() => expect(jobs.length).toBeGreaterThan(0), { timeout: 3_000 })
    const first = jobs[0]!, chars = first.system.length + first.prompt.length
    console.log(`[stack13] lookup teammate prompt: system ${first.system.length} + prompt ${first.prompt.length} = ${chars} chars`)
    expect(first.system).not.toContain(COLLECTION_RULE)
    expect(first.system).not.toContain(WORK_REPLY_RULE)
    expect(first.system).not.toContain(CHOICE_RULE)
    expect(first.system).not.toContain('file_create_copy')
    expect(first.prompt).not.toContain('```replies')
    expect(first.system.length).toBeLessThan(15_000)
    await team.stop('bot-b1')
  })
})

describe('stack-13 merge: one clock for the anonymous helpers\' hand-over', () => {
  const hire = async (createdAgoMs: number, alive: (url: string) => Promise<boolean>) => {
    const paths = await vault('clock')
    const created = await createTask(paths, '광주 비엔날레, 수원 마라톤 일정 각각 알아봐', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.createdAt = new Date(Date.now() - createdAgoMs).toISOString() })
    const calls: string[] = [], quick: string[] = [], asked: string[] = []
    const run: NonNullable<Parameters<typeof teamRunner>[0]['run']> = async (_deps, prompt, options = {}) => {
      calls.push(prompt.slice(0, 20)); options.onStart?.()
      const which = (options.persona ?? '').includes('"광주 비엔날레"') ? '광주 비엔날레는 12월 1일까지 열려요 https://dead.example/biennale' : '수원 마라톤은 11월 22일이에요 https://run.example/1'
      return { answer: which, steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit), alive: async url => { asked.push(url); return alive(url) } }
    const began = Date.now()
    const raw = await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '광주 비엔날레', brief: '광주 비엔날레 일정', lookup: true }, { role: '수원 마라톤', brief: '수원 마라톤 일정', lookup: true }] }, { task: '' })
    const out = JSON.parse(raw)
    return { out, took: Date.now() - began, calls, quick, asked }
  }

  it('with time left, a dead cited page is caught at hand-over; the path adds no model round and no quick call (R1/T1)', async () => {
    const r = await hire(0, async url => !url.includes('dead.example'))
    expect(r.asked).toEqual(expect.arrayContaining(['https://dead.example/biennale']))
    expect(r.out.members[0].result).toContain('(no live source)')
    expect(r.calls).toHaveLength(2)
    expect(r.quick).toEqual([])
  })

  it('the hand-over link check reads the task\'s deadline: past it, a page that never answers holds nothing up', async () => {
    const r = await hire(TEAM_ANSWER_MS, () => new Promise<boolean>(() => undefined))
    expect(r.took).toBeLessThan(500)
    expect(r.out.members[0].result).toContain('https://dead.example/biennale')
    expect(r.calls).toHaveLength(2)
  })
})

describe('stack-13 merge: no host process sentence on any path', () => {
  it('the templates that wrote who did what, how many, or what fit are gone from team, lone lookup and hire_members', () => {
    const code = ['../../../packages/core/src/company-tools.ts', '../../../packages/core/src/team-hire-tools.ts', '../src/main/fast-lane.ts', '../src/main/ipc.ts', '../src/main/team-runner.ts'].map(src).join('\n').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n')
    for (const gone of ['JOB_VERBS', 'jobForms', 'listShortfall', 'KOREAN_COUNT', '딱 맞는 건', '하나씩 맡아서', 'NEVER_CAME', '못 뽑았어요']) expect(code).not.toContain(gone)
  })
})
