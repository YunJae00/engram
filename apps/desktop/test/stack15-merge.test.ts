import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedLead, createBot, createTask, ITEM_CHECK_MS, judgeTime, kindChecked, mergedReport, officeTools, REPORT_WRITER_MS, reportData, settleMember, TEAM_ANSWER_MS, updateTask, writtenReport, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'

// stack-15: c15a (one item-judge clock, judge retry), c15b (a refused draft repaired in the one rewrite, the lead's answer checked) and c15c
// (memory yields to a starting turn, ppt_build) meet here. Wordings are not the harness's: 여수/통영 바다 날씨, teammates 하람 / 이든 / 보라.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-stack15-${tag}-`)), '.engram') } as unknown as VaultPaths }
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
// c18b: the one fix after a check is a scoped repair (core repairedWrite): replacements and insertions of numbered units, as JSON.
const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const none = JSON.stringify({ problems: [] })
const T0 = Date.parse('2026-11-18T03:00:00Z')
const part = (id: string, role: string, topic: string, text: string, url: string, at = T0): TeamMember => {
  const m: TeamMember = { id, parentId: null, depth: 1, role, brief: `${topic} 오늘 바다 날씨`, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date(at).toISOString() }
  const answer = block({ facts: [{ text, url }] })
  settleMember(m, { answer, report: reportData(answer, m, [], true) ?? null }, new Date(at + 1000).toISOString(), true)
  return m
}
// A part that ended with nothing to show (c15a left it empty): rule 7's line for it follows the message.
const empty = (id: string, role: string, topic: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${topic} 오늘 바다 날씨`, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date(T0).toISOString(), result: '', unfinished: true })
const YEOSU = 'https://sea.example.kr/yeosu', TONGYEONG = 'https://sea.example.kr/tongyeong'
const both = (lead: string, names = ['하람', '이든']): string => JSON.stringify({ message: `${lead}\n\n여수는 ${names[0]}이 봤는데 물결이 잔잔해요. [a](${YEOSU})${names[1] ? `\n통영은 ${names[1]}이 봤는데 풍랑주의보가 있어요. [b](${TONGYEONG})` : '\n통영은 풍랑주의보가 있어요. [b](' + TONGYEONG + ')'}`, kept: ['f1', 'f2'] })
afterEach(() => { vi.useRealTimers() })

describe('stack-15 merge: one clock', () => {
  it('a slow judge at the part\'s deadline, then a draft refused for its shape and repaired: the answer lands before 35 s', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    // c15a: the teammate's part ends 0.1 s before the team deadline; its item judge takes 4.5 s; judgeTime gives it what is left, at least
    // its usual 3 s, so the judgment ends at most ITEM_CHECK_MS past the deadline, unjudged.
    const due = T0 + TEAM_ANSWER_MS
    vi.setSystemTime(due - 100)
    const slowJudge = (): Promise<string> => new Promise(resolve => setTimeout(() => resolve('{"keep":[1]}'), 4_500))
    const data = { facts: [{ text: '여수 바다는 오늘 물결이 1미터로 잔잔해요.', url: YEOSU, site: '바다' }] }
    let judgedAt = 0
    const judging = kindChecked(data, '여수 오늘 바다 날씨', slowJudge, judgeTime(due)).then(out => { judgedAt = Date.now(); return out })
    await vi.advanceTimersByTimeAsync(ITEM_CHECK_MS)
    expect(await judging).toBe(data)
    expect(judgedAt).toBeLessThanOrEqual(due + ITEM_CHECK_MS)
    await vi.runAllTimersAsync() // the judge's own late answer is dropped
    vi.setSystemTime(judgedAt)
    // c15b: the writer's draft leaves 이든 out (structural "unnamed"): the refusal goes into the one rewrite, which is checked clean.
    const members = [part('m1', '하람', '여수', '여수 바다는 오늘 물결이 1미터로 잔잔해요.', YEOSU), part('m2', '이든', '통영', '통영 바다는 오늘 풍랑주의보가 있어요.', TONGYEONG)]
    const calls: string[] = []
    const write = (prompt: string): Promise<string> => new Promise(resolve => setTimeout(() => { calls.push(prompt); resolve(prompt.includes(CHECK) ? none : prompt.includes(REDO) ? JSON.stringify({ insert_after: { 3: ['통영은 이든이 봤어요.'] } }) : both('여수는 잔잔하고 통영은 풍랑주의보가 있어요.', ['하람'])) }, 800))
    const writing = writtenReport({ ask: '여수 통영 오늘 바다 날씨 나눠서 알아봐줘', members, write })
    await vi.runAllTimersAsync()
    const out = await writing
    // c18b: draft, its meaning check, the one scoped repair (a shape problem only: no second check).
    expect(calls).toHaveLength(3)
    expect(calls[1]).toContain(CHECK)
    expect(calls[2]).toContain('"kind":"shape"')
    expect(out).toContain('통영은 이든이 봤어요.')
    expect(Date.now() - T0).toBeLessThanOrEqual(TEAM_ANSWER_MS + ITEM_CHECK_MS + REPORT_WRITER_MS)
    expect(Date.now() - T0).toBeLessThan(35_000)
  })
})

describe('stack-15 merge: the repair keeps rule 7', () => {
  const members = (): TeamMember[] => [part('m1', '하람', '여수', '여수 바다는 오늘 물결이 1미터로 잔잔해요.', YEOSU), part('m2', '보라', '통영', '통영 바다는 오늘 풍랑주의보가 있어요.', TONGYEONG), empty('m3', '이든', '거제')]
  const ask = '여수 통영 거제 오늘 바다 날씨 나눠서 알아봐줘'
  it('a part left missing reaches the repair with its label; the repaired text keeps every link and the missing-part line follows it', async () => {
    const team = members(), calls: string[] = []
    const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? none : prompt.includes(REDO) ? both('여수는 잔잔하고 통영은 풍랑주의보가 있어요.', ['하람', '보라']) : both('여수는 잔잔하고 통영은 풍랑주의보가 있어요.', ['하람']) }
    const out = await writtenReport({ ask, members: team, write, timeoutMs: 8_000 })
    const data = JSON.parse(calls[2]!.split('\n').find(line => line.startsWith('Data: '))!.slice(6)) as { broughtNothing?: { name: string }[]; shownAfterMessage?: string }
    expect(data.broughtNothing?.map(one => one.name)).toEqual(['이든'])
    expect(out.endsWith(data.shownAfterMessage!)).toBe(true)
    expect(data.shownAfterMessage).toContain('거제(이든)')
    for (const url of [YEOSU, TONGYEONG]) expect(out).toContain(url)
  })
  it('a repair that fails too: the host rendering, with the missing-part line and every link', async () => {
    const team = members()
    const write = async (prompt: string): Promise<string> => prompt.includes(CHECK) ? none : both('여수는 잔잔하고 통영은 풍랑주의보가 있어요.', ['하람'])
    const out = await writtenReport({ ask, members: team, write, timeoutMs: 8_000 })
    // c18b: a shape rule never withholds the draft: unrepaired it is shown as written, and the missing-part line still follows it.
    expect(out).not.toBe(mergedReport(team))
    expect(out).toMatch(/^여수는 잔잔하고 통영은 풍랑주의보가 있어요\./)
    expect(out).toContain('거제(이든)')
    for (const url of [YEOSU, TONGYEONG]) expect(out).toContain(url)
    expect(out.trim()).not.toBe('')
  })
})

describe('stack-15 merge: the lead\'s answer check and background memory do not wait on each other', () => {
  it('a memory call under way and a turn starting: the lead check answers at once; the memory call is cut and runs after', async () => {
    let memoryRuns = 0
    const memory = yielding(signal => new Promise<string>((resolve, reject) => { memoryRuns++; if (memoryRuns > 1) return resolve('kept'); signal.addEventListener('abort', () => reject(new Error('cut'))) }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const started = turnRunning() // the next turn opens: the memory call is cut and waits for its first token
    const helpers: TeamMember[] = [{ id: 'h1', parentId: null, depth: 1, role: '여수', brief: '여수 바다 날씨', state: 'done', sessionKey: 's1', hiredAt: new Date().toISOString(), result: `여수 바다는 잔잔해요 ${YEOSU}`, sources: [YEOSU] }]
    const at = Date.now()
    const draft = `여수 바다는 잔잔해요. [a](${YEOSU})`
    const out = await checkedLead({ ask: '여수 바다 날씨', helpers, draft, quick: async () => none, due: Date.now() + 8_000 })
    expect(out).toBe(draft)
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
  it('"멈춰" during a shape repair ends the writer at once on the host rendering, with no further call', async () => {
    const members = [part('m1', '하람', '여수', '여수 바다는 오늘 잔잔해요.', YEOSU, Date.now()), part('m2', '이든', '통영', '통영 바다는 오늘 풍랑주의보가 있어요.', TONGYEONG, Date.now())]
    const ctl = new AbortController(), calls: string[] = []
    const write = async (prompt: string): Promise<string | undefined> => {
      calls.push(prompt)
      if (prompt.includes(REDO)) { setTimeout(() => ctl.abort(), 20); return new Promise<undefined>(() => undefined) }
      return both('여수는 잔잔해요.', ['하람'])
    }
    const at = Date.now()
    const out = await writtenReport({ ask: '여수 통영 바다 날씨', members, write, timeoutMs: 6_000, signal: ctl.signal })
    expect(Date.now() - at).toBeLessThan(500)
    // c18b: draft, its check, the repair the stop cut: no call after it. A shape rule never withholds the draft, so the draft comes back
    // (the session posts nothing after a stop).
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain(REDO)
    expect(out).toMatch(/^여수는 잔잔해요\./)
  })
  it('"멈춰" during the lead-answer check gives the draft back at once', async () => {
    const ctl = new AbortController()
    const helpers: TeamMember[] = [{ id: 'h1', parentId: null, depth: 1, role: '여수', brief: '여수 바다 날씨', state: 'done', sessionKey: 's1', hiredAt: new Date().toISOString(), result: `여수 바다는 잔잔해요 ${YEOSU}`, sources: [YEOSU] }]
    setTimeout(() => ctl.abort(), 20)
    const at = Date.now()
    expect(await checkedLead({ ask: '여수 바다 날씨', helpers, draft: '여수는 잔잔해요.', quick: () => new Promise<string>(() => undefined), due: Date.now() + 8_000, signal: ctl.signal })).toBe('여수는 잔잔해요.')
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
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit), alive: async () => true }
    await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '여수', brief: '여수 바다 날씨', lookup: true }, { role: '통영', brief: '통영 바다 날씨', lookup: true }] }, { task: '' })
    console.log(`[stack15] anonymous hire_members: ${calls.length} model calls, ${quick.length} quick calls (team-runner; the lane adds checkedLead: 1 quick check, +2 on a rewrite)`)
    expect(calls).toHaveLength(2)
    expect(quick).toEqual([])

    // C3 shape: three named teammates, each with a report; the item judge per part, then the writer, its meaning check.
    const paths3 = await vault('c3')
    for (const name of ['엔그램', '하람', '이든', '보라']) await createBot(paths3, { name })
    const ask = '여수, 통영, 거제 오늘 바다 날씨 하람, 이든, 보라한테 나눠서 시켜'
    const task3 = await createTask(paths3, ask, 'b1')
    await updateTask(paths3, task3.id, t => { t.state = 'running'; t.turns = 1 })
    const models: string[] = [], quicks: string[] = []
    const where: Record<string, [string, string]> = { 하람: ['여수', YEOSU], 이든: ['통영', TONGYEONG], 보라: ['거제', 'https://sea.example.kr/geoje'] }
    const run3: Run = async (_deps, prompt, options = {}) => {
      options.onStart?.(); models.push(prompt.slice(0, 20))
      const who = Object.keys(where).find(name => (options.persona ?? '').includes(name))!
      return { answer: block({ facts: [{ text: `${where[who]![0]} 바다는 오늘 잔잔해요.`, url: where[who]![1] }] }), steps: [], fellBack: false }
    }
    const message = JSON.stringify({ message: `세 곳 다 오늘 바다가 잔잔해요.\n\n여수는 하람이 봤어요. [a](${YEOSU})\n통영은 이든이 봤어요. [b](${TONGYEONG})\n거제는 보라가 봤어요. [c](https://sea.example.kr/geoje)`, kept: ['f1', 'f2', 'f3'] })
    const quick3 = async (prompt: string): Promise<string | undefined> => { quicks.push(prompt.includes(CHECK) ? 'check' : prompt.includes('"lists"') ? 'judge' : 'writer'); return prompt.includes(CHECK) ? none : prompt.includes('"lists"') ? '{"keep":[1],"lists":[]}' : message }
    const team3 = teamRunner({ paths: paths3, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run: run3 })
    const kit3: TurnKit = { engine: { id: 'claude', quick: quick3 } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async lane => team3.tools(lane, kit3) }
    const answer = await team3.tools('bot-b1', kit3, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하람', brief: '여수 오늘 바다 날씨', topic: '여수' }, { who: '이든', brief: '통영 오늘 바다 날씨', topic: '통영' }, { who: '보라', brief: '거제 오늘 바다 날씨', topic: '거제' }] }, { task: ask })
    const count = (kind: string): number => quicks.filter(one => one === kind).length
    console.log(`[stack15] C3-shape team answer: ${models.length} model calls, ${quicks.length} quick calls (judge ${count('judge')}, writer ${count('writer')}, check ${count('check')})`)
    expect(answer).toContain('보라')
    expect(models).toHaveLength(3)
    expect(count('judge')).toBe(3)
    expect(count('writer')).toBe(1)
    expect(count('check')).toBe(1)
  })
})
