import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBot, createTask, employeesAnswer, handBacks, officeTools, partOutcome, runToolSession, settleMember, TEAM_ANSWER_MS, updateTask, type DelegatedTask, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-stack15-${tag}-`)), '.engram') } as unknown as VaultPaths }
const T0 = Date.parse('2026-11-18T03:00:00Z')
const part = (id: string, role: string, topic: string, text: string, url: string, at = T0): TeamMember => {
  const m: TeamMember = { id, parentId: null, depth: 1, role, brief: `${topic} 오늘 바다 날씨`, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: new Date(at).toISOString() }
  settleMember(m, { answer: `${text} ${url}`, sources: [url] }, new Date(at + 1000).toISOString(), true)
  return m
}
const empty = (id: string, role: string, topic: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${topic} 오늘 바다 날씨`, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date(T0).toISOString(), result: '', unfinished: true })
const YEOSU = 'https://sea.example.kr/yeosu', TONGYEONG = 'https://sea.example.kr/tongyeong'
const handed = (members: TeamMember[]): { reports: Report[]; note: string } => JSON.parse(handBacks(members)) as { reports: Report[]; note: string }
const posted = async (draft: string, ask: string, quick?: () => Promise<string>): Promise<string> => (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }), ...(quick ? { quick } : {}) } as never, workdir: '/x', tools: [] }, ask, {})).answer
const crew = async (tag: string, names: string[], ask: string, run: Run) => {
  const paths = await vault(tag)
  for (const name of ['엔그램', ...names]) await createBot(paths, { name })
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const quick: string[] = []
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
  return { team, quick, assign: team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')! }
}
afterEach(() => { vi.useRealTimers() })

describe('stack-15 merge: one clock', () => {
  it('at the part\'s deadline the hand-back is ready with no judge and no writer round of the host, so the lead\'s one step is all that is left before 35 s', () => {
    vi.useFakeTimers({ now: T0 + TEAM_ANSWER_MS, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const members = [part('m1', '하람', '여수', '여수 바다는 오늘 물결이 1미터로 잔잔해요.', YEOSU), part('m2', '이든', '통영', '통영 바다는 오늘 풍랑주의보가 있어요.', TONGYEONG)]
    const task: DelegatedTask = { id: 'job', goal: '여수 통영 오늘 바다 상태 둘이 하나씩 봐줘', botId: 'lead', state: 'running', turns: 1, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), approvals: [], log: [], team: { members, hires: 2, maxHires: 8, maxDepth: 3, big: false } }
    const out = employeesAnswer(task)
    expect(Date.now() - T0).toBe(TEAM_ANSWER_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect((JSON.parse(out!) as { reports: Report[] }).reports.map(one => one.result)).toEqual([`여수 바다는 오늘 물결이 1미터로 잔잔해요. ${YEOSU}`, `통영 바다는 오늘 풍랑주의보가 있어요. ${TONGYEONG}`])
    expect(Object.keys(JSON.parse(out!) as object)).toEqual(['reports', 'note'])
  })
})

describe('stack-15 merge: the repair keeps rule 7', () => {
  const members = (): TeamMember[] => [part('m1', '하람', '여수', '여수 바다는 오늘 물결이 1미터로 잔잔해요.', YEOSU), part('m2', '보라', '통영', '통영 바다는 오늘 풍랑주의보가 있어요.', TONGYEONG), empty('m3', '이든', '거제')]
  const ask = '여수 통영 거제 오늘 바다 날씨 나눠서 알아봐줘'
  it('a part left missing reaches the lead with its name and part and no words; the parts with words keep every link', () => {
    const team = members(), got = handed(team)
    expect(team.map(partOutcome)).toEqual(['found', 'found', 'unfinished'])
    expect(got.reports[2]).toEqual({ who: '이든', part: '거제', state: 'done', result: '' })
    expect(got.reports.slice(0, 2).map(one => one.sources)).toEqual([[YEOSU], [TONGYEONG]])
    for (const url of [YEOSU, TONGYEONG]) expect(got.reports.map(one => one.result).join('\n')).toContain(url)
    expect(got.note).toContain('Say plainly which part failed or is missing.')
  })
  it('a draft that leaves the missing part out is posted as written: no host line follows it, and saying the part is the model\'s rule', async () => {
    const draft = `여수는 잔잔하고 통영은 풍랑주의보가 있어요.\n\n여수는 하람이 봤어요. [바다 예보](${YEOSU})\n통영은 보라가 봤어요. [바다 예보](${TONGYEONG})`
    const out = await posted(draft, ask)
    expect(out).toBe(draft)
    expect(out).not.toContain('거제')
    expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
    expect(Object.keys(JSON.parse(handBacks(members())) as object)).toEqual(['reports', 'note'])
  })
})

describe('stack-15 merge: the lead\'s answer check and background memory do not wait on each other', () => {
  it('a memory call under way and a turn starting: the lead\'s draft is the answer at once, with no check call; the memory call is cut and runs after', async () => {
    let memoryRuns = 0
    const memory = yielding(signal => new Promise<string>((resolve, reject) => { memoryRuns++; if (memoryRuns > 1) return resolve('kept'); signal.addEventListener('abort', () => reject(new Error('cut'))) }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const started = turnRunning()
    const at = Date.now()
    const draft = `여수 바다는 잔잔해요. [바다 예보](${YEOSU})`
    let quicks = 0
    const out = await posted(draft, '여수 바다 날씨', async () => { quicks++; return '' })
    expect(out).toBe(draft)
    expect(quicks).toBe(0)
    expect(Date.now() - at).toBeLessThan(200)
    expect(memoryRuns).toBe(1)
    started()
    expect(await memory).toBe('kept')
    expect(memoryRuns).toBe(2)
  })
  it('a "기억해" turn nothing kept is never dropped, however many turns start (c15c review)', async () => {
    let runs = 0
    const call = yielding(signal => new Promise<string>((resolve, reject) => { runs++; if (runs > 5) return resolve('kept'); signal.addEventListener('abort', () => reject(new Error('cut'))) }), undefined, true)
    for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); turnRunning()() }
    expect(await call).toBe('kept')
    expect(runs).toBe(6)
  })
})

describe('stack-15 merge: stop', () => {
  it('"멈춰" while a teammate still writes ends the lead\'s wait at once, with no further call', async () => {
    let runs = 0, started: (() => void) | undefined
    const writing = new Promise<void>(resolve => { started = resolve })
    const { team, assign, quick } = await crew('stop', ['하람', '이든'], '여수 통영 바다 날씨', async (_deps, _prompt, options = {}) => {
      options.onStart?.(); runs++
      if ((options.persona ?? '').includes('하람')) return { answer: `여수 바다는 오늘 잔잔해요. ${YEOSU}`, steps: [], fellBack: false }
      started!()
      return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const work = assign.run({ wait: true, to: [{ who: '하람', brief: '여수 오늘 바다 날씨', topic: '여수' }, { who: '이든', brief: '통영 오늘 바다 날씨', topic: '통영' }] }, { task: '' }).catch(() => 'stopped')
    await writing
    const at = Date.now()
    await team.stop('bot-b1')
    await work
    expect(Date.now() - at).toBeLessThan(500)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(runs).toBe(2)
    expect(quick).toEqual([])
  })
  it('"멈춰" after the draft finds nothing to stop: the draft is already the answer, and a quick model that never answers holds nothing up', async () => {
    const at = Date.now()
    expect(await posted('여수는 잔잔해요.', '여수 바다 날씨', () => new Promise<string>(() => undefined))).toBe('여수는 잔잔해요.')
    expect(Date.now() - at).toBeLessThan(500)
  })
  it('"멈춰" during a deck build ends the tool at once', async () => {
    const ctl = new AbortController()
    const build = officeTools({ run: (_op, _args, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped')))) }).find(tool => tool.name === 'ppt_build')!
    setTimeout(() => ctl.abort(), 20)
    const at = Date.now()
    await expect(build.run({ slides: [{ title: '분기 실적' }, { title: '매출', bullets: ['매출이 10% 늘었어요'] }] }, { task: '발표 자료', signal: ctl.signal })).rejects.toThrow()
    expect(Date.now() - at).toBeLessThan(500)
  })
})

describe('stack-15 merge: call counts', () => {
  it('anonymous hire_members with two parts that bring data, and a C3-shape answer of three teammates', async () => {
    const paths = await vault('count')
    const created = await createTask(paths, '여수, 통영 오늘 바다 날씨 각각 알아봐', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const calls: string[] = [], quick: string[] = []
    const run: Run = async (_deps, prompt, options = {}) => {
      calls.push(prompt.slice(0, 20)); options.onStart?.()
      return { answer: (options.persona ?? '').includes('"여수"') ? `여수 바다는 잔잔해요 ${YEOSU}` : `통영은 풍랑주의보가 있어요 ${TONGYEONG}`, steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
    await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '여수', brief: '여수 바다 날씨', lookup: true }, { role: '통영', brief: '통영 바다 날씨', lookup: true }] }, { task: '' })
    console.log(`[stack15] anonymous hire_members: ${calls.length} model calls, ${quick.length} quick calls`)
    expect(calls).toHaveLength(2)
    expect(quick).toEqual([])

    const ask = '여수, 통영, 거제 오늘 바다 날씨 하람, 이든, 보라한테 나눠서 시켜'
    const models: string[] = []
    const where: Record<string, [string, string]> = { 하람: ['여수', YEOSU], 이든: ['통영', TONGYEONG], 보라: ['거제', 'https://sea.example.kr/geoje'] }
    const three = await crew('c3', ['하람', '이든', '보라'], ask, async (_deps, prompt, options = {}) => {
      options.onStart?.(); models.push(prompt.slice(0, 20))
      const who = Object.keys(where).find(name => (options.persona ?? '').includes(name))!
      return { answer: `${where[who]![0]} 바다는 오늘 잔잔해요. ${where[who]![1]}`, steps: [], fellBack: false }
    })
    const answer = JSON.parse(await three.assign.run({ wait: true, to: [{ who: '하람', brief: '여수 오늘 바다 날씨', topic: '여수' }, { who: '이든', brief: '통영 오늘 바다 날씨', topic: '통영' }, { who: '보라', brief: '거제 오늘 바다 날씨', topic: '거제' }] }, { task: ask })) as { reports: Report[] }
    console.log(`[stack15] C3-shape team answer: ${models.length} model calls, ${three.quick.length} quick calls`)
    expect(answer.reports.map(one => [one.who, one.result])).toEqual(Object.entries(where).map(([who, [place, url]]) => [who, `${place} 바다는 오늘 잔잔해요. ${url}`]))
    expect(models).toHaveLength(3)
    expect(three.quick).toEqual([])
  })
})
