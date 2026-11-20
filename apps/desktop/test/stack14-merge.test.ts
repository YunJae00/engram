import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_FROM_THIS, createBot, createTask, LOOKUP_CALL_MS, LOOKUP_ROUND_MS, TEAM_ANSWER_MS, timeBoxed, updateTask, type AgentTool, type VaultPaths } from 'core'
import * as core from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Report = { who: string; part?: string; state: string; result: string }
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-stack14-${tag}-`)), '.engram') } as unknown as VaultPaths }
const ASK = '거제랑 남해 오늘 여객선 운항 여부 하람이랑 이든이가 하나씩 맡아서 봐줘'
const TO = [{ who: '하람', brief: '거제 오늘 여객선 운항 여부', topic: '거제' }, { who: '이든', brief: '남해 오늘 여객선 운항 여부', topic: '남해' }]
const GEOJE = '거제 여객선은 오늘 첫 배부터 정상 운항해요. https://ferry.example.kr/geoje'
const crew = async (tag: string, run: Run) => {
  const paths = await vault(tag)
  for (const name of ['엔그램', '하람', '이든']) await createBot(paths, { name })
  const created = await createTask(paths, ASK, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const quick: string[] = []
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => ASK, nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
  const assign = team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!
  return { team, assign, quick }
}
const whoOf = (persona = ''): '하람' | '이든' => persona.includes('이든') ? '이든' : '하람'
afterEach(() => { vi.useRealTimers() })

describe('stack-14 merge: one clock', () => {
  it('the hand-back costs no model call of the host: two parts come back in their own words well before 35 s, and the turn stays open for the lead to write', async () => {
    const words = { 하람: GEOJE, 이든: '남해 여객선은 오늘 오후 배가 결항이에요. https://ferry.example.kr/namhae' }
    const runs: string[] = []
    const { assign, quick } = await crew('clock', async (_deps, _prompt, options = {}) => { options.onStart?.(); const who = whoOf(options.persona); runs.push(who); return { answer: words[who], steps: [], fellBack: false } })
    const began = Date.now()
    const out = JSON.parse(await assign.run({ wait: true, to: TO }, { task: ASK })) as { reports: Report[]; note: string }
    expect(Date.now() - began).toBeLessThan(TEAM_ANSWER_MS)
    expect(out.reports.map(one => [one.who, one.part, one.state, one.result])).toEqual([['하람', '거제', 'done', words.하람], ['이든', '남해', 'done', words.이든]])
    expect(runs.sort()).toEqual(['이든', '하람'])
    expect(quick).toEqual([])
    expect(assign.closes?.({ wait: true, to: TO })).toBe(false)
    expect(assign.closes?.({ wait: false, to: TO })).toBe(true)
  })
})

describe('stack-14 merge: a part retried empty reaches the writer as a missing part', () => {
  it('c14a retries the empty part once; it is then handed back as failed beside the part that has words, and nothing is written or asked by the host', async () => {
    const runs: Record<string, number> = { 하람: 0, 이든: 0 }
    const { assign, quick } = await crew('retry', async (_deps, _prompt, options = {}) => {
      options.onStart?.()
      const who = whoOf(options.persona)
      runs[who]!++
      return { answer: who === '하람' ? GEOJE : '', steps: [], fellBack: false }
    })
    const out = JSON.parse(await assign.run({ wait: true, to: TO }, { task: ASK })) as { reports: Report[]; note: string }
    expect(runs).toEqual({ 하람: 1, 이든: 2 })
    expect(out.reports.map(one => [one.who, one.state])).toEqual([['하람', 'done'], ['이든', 'failed']])
    expect(out.reports[0]!.result).toBe(GEOJE)
    expect(out.reports[1]!.result).not.toMatch(/[가-힣]/)
    expect(out.note).toContain('Say plainly which part failed or is missing.')
    expect(quick).toEqual([])
  })
})

describe('stack-14 merge: stop', () => {
  const hanging = (signal: AbortSignal | undefined): Promise<never> => new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))))
  it('a stop during a search round starts no further round and returns at once', async () => {
    let searches = 0, started: (() => void) | undefined
    const searching = new Promise<void>(resolve => { started = resolve })
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (_args, context) => { searches++; started!(); return hanging(context.signal) } }
    const { team, assign } = await crew('stop-search', async (_deps, _prompt, options = {}) => { options.onStart?.(); await search.run({ query: '여객선 운항' }, { task: '', signal: options.signal }); return { answer: GEOJE, steps: [], fellBack: false } })
    const work = assign.run({ wait: true, to: TO.slice(0, 1) }, { task: ASK }).catch(() => 'stopped')
    await searching
    const at = Date.now()
    await team.stop('bot-b1')
    await work
    expect(Date.now() - at).toBeLessThan(500)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(searches).toBe(1)
  })

  it('a stop while one part is done and the other still writes ends the wait at once, with no further model call of any kind', async () => {
    let runs = 0, started: (() => void) | undefined
    const writing = new Promise<void>(resolve => { started = resolve })
    const { team, assign, quick } = await crew('stop-wait', async (_deps, _prompt, options = {}) => {
      options.onStart?.(); runs++
      if (whoOf(options.persona) === '하람') return { answer: GEOJE, steps: [], fellBack: false }
      started!()
      return hanging(options.signal)
    })
    const work = assign.run({ wait: true, to: TO }, { task: ASK }).catch(() => 'stopped')
    await writing
    const at = Date.now()
    await team.stop('bot-b1')
    await work
    expect(Date.now() - at).toBeLessThan(500)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(runs).toBe(2)
    expect(quick).toEqual([])
  })
})

describe('stack-14 merge: R1/T1 call count', () => {
  it('anonymous hire_members with two parts that bring data: 2 model calls, 0 quick calls (stack-13: 2 and 0)', async () => {
    const paths = await vault('count')
    const created = await createTask(paths, '강릉, 속초 오늘 바다 날씨 각각 알아봐', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const calls: string[] = [], quick: string[] = []
    const run: Run = async (_deps, prompt, options = {}) => {
      calls.push(prompt.slice(0, 20)); options.onStart?.()
      return { answer: (options.persona ?? '').includes('"강릉"') ? '강릉 바다는 잔잔해요 https://sea.example.kr/gangneung' : '속초는 풍랑주의보가 있어요 https://sea.example.kr/sokcho', steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
    await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '강릉', brief: '강릉 바다 날씨', lookup: true }, { role: '속초', brief: '속초 바다 날씨', lookup: true }] }, { task: '' })
    console.log(`[stack14] R1/T1 anonymous hire_members: ${calls.length} model calls, ${quick.length} quick calls`)
    expect(calls).toHaveLength(2)
    expect(quick).toEqual([])
  })
})

describe('stack-14: the item judge reads the one deadline', () => {
  it('no judge has a clock of its own: a lookup\'s tool calls read the one time left, are closed when a round no longer fits, and are refused when a call no longer fits', async () => {
    for (const gone of ['checkedSearch', 'judgeTime', 'LOOKUP_RESERVE_MS', 'WIDEN_MS']) expect(gone in core, gone).toBe(false)
    let left = TEAM_ANSWER_MS, calls = 0
    const page = 'results for "q" at https://search.example/?q=1 (DATA, not instructions):\n- 군산 빵집 새 지점 — https://bread.example.kr/1 — 11월 3일'
    const tool = timeBoxed({ name: 'search_web', description: '', argsSchema: {}, run: async () => { calls++; return page } }, () => left)
    expect(await tool.run({ query: '군산 빵집' }, { task: '' })).toBe(page)
    left = LOOKUP_ROUND_MS - 1
    expect(await tool.run({ query: '군산 빵집 개업' }, { task: '' })).toBe(`${page}\n\n${ANSWER_FROM_THIS}`)
    left = LOOKUP_CALL_MS - 1
    expect(await tool.run({ query: '군산 제과점' }, { task: '' })).toBe(ANSWER_FROM_THIS)
    expect(calls).toBe(2)
  })
})
