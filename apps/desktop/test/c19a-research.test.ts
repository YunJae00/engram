import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { calendarLine, createTask, updateTask, type AgentTool, type Engine, type ToolSessionJob, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import * as fastLane from '../src/main/fast-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { answer, openWorld } from '../src/main/answer.js'

const leadOnly = (lead: (job: ToolSessionJob) => Promise<string>): Engine => ({ id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), runTools: async (job: ToolSessionJob) => ({ answer: await lead(job) }) }) as unknown as Engine

describe('7. relative days come from one calendar on every lead step; nothing rewrites a lookup answer after the reader', () => {
  it('every ask, dated or not, gets today and the next 14 days with weekdays, so a named day resolves without the host reading the words', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2027, 0, 8, 10, 0))
      const told: string[] = []
      const world = await openWorld(await mkdtemp(join(temporary, 'engram-c19a-days-')), leadOnly(async job => { told.push(job.prompt); return '알겠어요.' }))
      for (const ask of ['다음 주 월요일이랑 목요일 춘천 미세먼지 알려줘', '모레 여수 바람 세기 좀 봐줄래', '탕비실 정수기 필터 갈아 끼우는 법 정리해줘']) await answer(world, ask)
      expect(told).toHaveLength(3)
      for (const prompt of told) {
        expect(prompt).toContain('2027-01-08 Fri, 01-09 Sat')
        expect(prompt).toContain('01-10 Sun')
        expect(prompt).toContain('01-11 Mon')
        expect(prompt).toContain('01-14 Thu')
        expect(prompt).toContain('01-21 Thu')
        expect(prompt).not.toContain('01-22')
        expect(prompt).toContain('never say how a date was worked out')
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      expect(calendarLine(new Date(2027, 0, 8))).toMatch(new RegExp(`^${zone} calendar, today first: 2027-01-08 Fri, `))
      expect(calendarLine(new Date(2027, 0, 8)).length - zone.length).toBeLessThanOrEqual(245)
      vi.setSystemTime(new Date(2027, 11, 29, 23, 30))
      told.length = 0
      await answer(world, '새해 첫 주 화요일 강릉 해돋이 시각')
      expect(told[0]).toContain('2027-12-29 Wed')
      expect(told[0]).toContain('12-31 Fri, 01-01 Sat')
    } finally { vi.useRealTimers() }
  })

  it('a place changed while the lead\'s search runs reaches that same turn, and the one answer is about the new place, well inside the lookup cap', async () => {
    const queries: string[] = [], waiting: string[] = []
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async args => { const q = String(args['query']); queries.push(q); if (queries.length === 1) waiting.push('아 목포 말고 순천으로 봐줘'); await tick(MS.search); return `results for "${q}"\n- ${q} — ${PAGE(q)}` } }
    const engine = leadOnly(async job => {
      const first = await job.tools.find(tool => tool.name === 'search_web')!.run({ query: '목포 오늘 일몰' })
      const text = typeof first === 'string' ? first : first.text
      if (!text.includes('순천')) return '목포는 오늘 17시 31분에 해가 져요.'
      await job.tools.find(tool => tool.name === 'search_web')!.run({ query: '순천 오늘 일몰' })
      return `순천은 오늘 17시 29분에 해가 져요. [일몰 시각](${PAGE('순천 오늘 일몰')})`
    })
    const since = Date.now()
    const { result } = await answer(await openWorld(await mkdtemp(join(temporary, 'engram-c19a-swap-')), engine), '목포 오늘 해 지는 시각 알려줘', { tools: [search], takeSteer: () => waiting.splice(0) })
    expect(Date.now() - since).toBeLessThan(20_000)
    expect(queries).toEqual(['목포 오늘 일몰', '순천 오늘 일몰'])
    expect(result?.answer).toMatch(/^순천/)
    expect(result?.answer).not.toContain('목포')
  })

  it('no post-hoc rewrite is left to run after the reader ends', () => {
    expect(Object.keys(fastLane).filter(name => typeof (fastLane as Record<string, unknown>)[name] === 'function').sort()).toEqual(['asideShape', 'teamAsk'])
  })
})

const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c19a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Seen = { role: string; state: string; result?: string; sources?: string[] }
const seenIn = (text: string): { members: Seen[]; note: string } => JSON.parse(text) as { members: Seen[]; note: string }
const PAGE = (town: string): string => `https://sunset.example/${encodeURIComponent(town)}`
const MS = { search: 150, model: 600 }

async function split(tag: string, towns: string[], steer?: number) {
  const paths = await vault(tag), ask = `${towns.join(' ')} 오늘 해 지는 시각 각각 좀 알아봐줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const firstPrompts: string[] = []
  let quick = 0
  const town = (text: string): string => [...towns, '군산'].find(one => text.includes(one)) ?? towns[0]!
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), c = town(q); await tick(MS.search)
    return [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, 'Results, each as title — its own address — what it says — its date.', `- ${c} 일몰 — ${PAGE(c)} — 오늘 해 지는 시각 오후 5시 19분 — 11월 18일`, `- ${c} 노을 명소 — https://trip.example/${encodeURIComponent(c)} — 사진 찍기 좋은 곳 — 11월 2일`].join('\n')
  } }
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    firstPrompts.push(prompt)
    const c = town(prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '')
    await tick(MS.model)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${c}은 오늘 오후 5시 19분에 해가 져요. [일몰 시각](${PAGE(c)})`, steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async () => { quick++; return undefined } } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (steer !== undefined) setTimeout(() => heard!(), steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const since = Date.now()
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  const members = (names: string[]) => names.map(c => ({ role: `${c} 조사`, topic: c, brief: `${c} 오늘 해 지는 시각`, query: `${c} 일몰 시각`, lookup: true }))
  return { hire, members, since, firstPrompts, quickCalls: () => quick }
}

describe('9. the first search in the first prompt; the split hands back inside the cap', () => {
  it('a 3-helper split: each helper\'s first engine call already holds its search rows, and every result comes back with its link before 35 s, with no host model call', async () => {
    const { hire, members, since, firstPrompts, quickCalls } = await split('three', ['태안', '보령', '서천'])
    const text = await hire.run({ members: members(['태안', '보령', '서천']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(35_000)
    expect(firstPrompts).toHaveLength(3)
    for (const prompt of firstPrompts) expect(prompt).toMatch(/Results of the search already run for you \("[^"\n]*일몰 시각[^"\n]*"\)[\s\S]*https:\/\/sunset\.example\/[^\n]*오후 5시 19분/)
    const seen = seenIn(text).members
    expect(seen.map(one => one.state)).toEqual(['released', 'released', 'released'])
    for (const c of ['태안', '보령', '서천']) expect(seen.find(one => one.role === `${c} 조사`)!.result).toContain(`](${PAGE(c)})`)
    expect(seen.some(one => one.result!.includes('못 찾았어요'))).toBe(false)
    expect(quickCalls()).toBe(0)
  }, 45_000)

  it('a 4-part split with one part added mid-work: the lead hears the person at once, adds the part, and gets all four results before 40 s', async () => {
    const { hire, members, since } = await split('steer', ['태안', '보령', '서천'], 100)
    const first = seenIn(await hire.run({ members: members(['태안', '보령', '서천']) }, { task: '' }))
    expect(first.members.map(one => one.state)).toEqual(['working', 'working', 'working'])
    expect(first.note).toContain('The person wrote to you while the team worked')
    const text = await hire.run({ members: members(['군산']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(40_000)
    const seen = seenIn(text).members
    expect(seen).toHaveLength(4)
    for (const c of ['태안', '보령', '서천', '군산']) expect(seen.find(one => one.role === `${c} 조사`)!.result).toContain(`](${PAGE(c)})`)
  }, 50_000)
})
