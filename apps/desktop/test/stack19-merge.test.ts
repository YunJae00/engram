import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, handBacks, officeTools, runToolSession, setReportLog, updateTask, type AgentTool, type Engine, type EngineCwd, type TeamMember, type ToolSessionJob, type ToolSessionResult, type VaultPaths } from 'core'
import * as core from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { closingBuilds } from '../src/main/desk-lane.js'
import * as desk from '../src/main/desk-lane.js'
import * as firstLine from '../src/main/first-line.js'
import * as fastLane from '../src/main/fast-lane.js'
import { laneToday } from '../src/main/fast-lane.js'
import { answerOnly } from '../src/main/result-check.js'
import { answerBubbles } from '../src/renderer/src/markdown.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const root = fileURLToPath(new URL('../../../', import.meta.url))
const temporary = join(root, 'tmp')
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s19-${tag}-`)), '.engram') } as unknown as VaultPaths }
const OLD_JUDGE = 'In "holds", for each item', OLD_STATED = 'Read the words alone'
const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
})
const fake = (): void => { vi.useFakeTimers({ now: Date.parse('2026-11-19T03:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] }) }
async function drive<T>(work: Promise<T>, step = 20): Promise<T> {
  let done = false
  void work.finally(() => { done = true }).catch(() => undefined)
  while (!done) { await vi.advanceTimersByTimeAsync(step); await new Promise(resolve => setImmediate(resolve)) }
  return work
}
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })

async function sources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const one of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, one.name)
    if (one.isDirectory()) out.push(...await sources(path))
    else if (/\.tsx?$/.test(one.name)) out.push(await readFile(path, 'utf8'))
  }
  return out
}

describe('stack-19: no judgement gate is left on the research path', () => {
  it('nothing c19a deleted is defined or called anywhere in core or the main process', async () => {
    const text = [...await sources(join(root, 'packages/core/src')), ...await sources(join(root, 'apps/desktop/src/main'))].join('\n')
    for (const gone of ['evidenced', 'statesTail', 'inOrder', 'Proof', 'proved', 'pageOf', 'pointName', 'notFoundLine', 'withEveryone', 'itemsFirst', 'pairShare', 'heldAnswer', 'weekendAnswer', 'WEEKEND_NOTE', 'perDay', 'GAVE_UP', 'laneSaid', 'noEmptyFences']) expect(new RegExp(`(function|const|let|class|type|interface)\\s+${gone}\\b|\\b${gone}\\s*[(<]`).test(text), gone).toBe(false)
    expect(/\bstated\(/.test(text)).toBe(false)
    expect(text.includes(OLD_JUDGE)).toBe(false)
    expect(text.includes(OLD_STATED)).toBe(false)
  })

  it('after a lone reader ends, a Korean cited answer is the turn\'s answer with no quick call and unchanged', async () => {
    const answer = '청주 육거리시장은 오늘 저녁 8시까지 열어요. [청주시](https://www.cheongju.go.kr/market)'
    let calls = 0
    const out = await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer }), quick: async () => { calls++; return '{"notes":[1]}' } } as never, workdir: '/x', tools: [] }, '청주 육거리시장 오늘 몇 시까지 해?', { lookup: true })
    expect(out.answer).toBe(answer)
    expect(calls).toBe(0)
    expect('laneTidy' in fastLane).toBe(false)
    for (const gone of ['dropWorkingNotes', 'withTheirWords']) expect(gone in firstLine, gone).toBe(false)
  })
})

const MS = { search: 1500, model: 6000 }
const PAGE = (city: string): string => `https://bus.example/${encodeURIComponent(city)}`
const own = (c: string): string => `${c} 시내버스 첫차는 오전 5시 30분이에요. [${c} 시간표](${PAGE(c)})`
type Handed = { members: { state: string; result?: string }[]; note: string }

async function split(tag: string, cities: string[], added?: { city: string; at: number }) {
  const paths = await vault(tag), ask = `${cities.join(' ')} 시내버스 첫차 시간 각각 알아봐줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const quick: string[] = []
  const all = [...cities, ...(added ? [added.city] : [])], city = (text: string): string => all.find(one => text.includes(one)) ?? cities[0]!
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), c = city(q); await wait(MS.search)
    return [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, `- ${c} 시내버스 시간표 — ${PAGE(c)} — 첫차 안내 — 11월 18일`, `- ${c} 여행 후기 — https://blog.example/${encodeURIComponent(c)} — 맛집 — 10월 2일`].join('\n')
  } }
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    const c = city(prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '')
    await wait(MS.model)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: own(c), steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = added ? new Promise<void>(resolve => { heard = resolve }) : undefined
  if (added) setTimeout(() => heard!(), added.at)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const since = Date.now()
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  const members = (names: string[]) => names.map(c => ({ role: `${c} 조사`, topic: c, brief: `${c} 시내버스 첫차 시간`, query: `${c} 시내버스 첫차`, lookup: true }))
  return { hire, members, since, quick }
}

const WORKDIR = join(temporary, 'stack19') as EngineCwd
const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: script }) as unknown as Engine
const SLIDES = [{ title: '동네 도서관 소개' }, { title: '이용 시간', bullets: ['평일 오전 9시부터 밤 10시'] }, { title: '프로그램', bullets: ['주말 그림책 읽기'] }]
const receipt = { artifact: 'a9', path: '/out/동네 도서관 소개.pptx', markdownLink: '[동네 도서관 소개.pptx](engram-artifact:a9)', completeReadback: true }

describe('stack-19: one clock (fake time) across both branches', () => {
  it('a 3-part split hands over under 35 s, the helpers\' own sentences are what the lead gets, and no judge or writer prompt of the host runs', async () => {
    fake()
    const { hire, members, since, quick } = await split('three', ['순천', '여수', '광양'])
    const text = await drive(hire.run({ members: members(['순천', '여수', '광양']) }, { task: '' }))
    expect(Date.now() - since).toBeLessThan(35_000)
    expect((JSON.parse(text) as Handed).members.map(m => m.result)).toEqual(['순천', '여수', '광양'].map(own))
    expect(quick).toEqual([])
    expect(hire.closesOn?.(text) ?? false).toBe(false)
    for (const gone of ['mergingHire', 'helperAnswer']) expect(gone in core, gone).toBe(false)
  }, 30_000)

  it('a 4-part split with one part added mid-work: one hand-over with all four under 40 s', async () => {
    fake()
    const { hire, members, since, quick } = await split('steer', ['순천', '여수', '광양'], { city: '목포', at: 3000 })
    const first = await drive(hire.run({ members: members(['순천', '여수', '광양']) }, { task: '' }))
    expect((JSON.parse(first) as Handed).members.map(m => m.state)).toEqual(['working', 'working', 'working'])
    const text = await drive(hire.run({ members: members(['목포']) }, { task: '' }))
    expect(Date.now() - since).toBeLessThan(40_000)
    expect((JSON.parse(text) as Handed).members.map(m => m.result)).toEqual(['순천', '여수', '광양', '목포'].map(own))
    expect(quick).toEqual([])
  }, 30_000)

  it('a deck build ends under 60 s: 25 s to the build, a 2 s build that closes the turn with the model\'s reply, and nothing is checked or read back after', async () => {
    fake()
    const tools = officeTools({ run: async () => { await wait(2000); return receipt } })
    let read = 0, quick = 0
    const reader: AgentTool = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, run: async () => { read++; return '{}' } }
    const reply = '동네 도서관 소개 자료를 3장으로 만들었어요. 이용 시간은 표 대신 한 줄로 넣었어요.'
    const engine = { ...brain(async job => {
      await wait(25_000)
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES, reply, more: false })
      await wait(15_000)
      await job.tools.find(tool => tool.name === 'file_read_package')!.run({})
      await wait(15_000)
      return { answer: 'late' }
    }), quick: async () => { quick++; return '' } } as Engine
    const since = Date.now()
    const done = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(tools), reader] }, '동네 도서관 소개 발표 자료 3장 만들어줘'))
    expect(Date.now() - since).toBeLessThan(60_000)
    expect(done.answer).toBe(reply)
    expect(done.files).toEqual([{ name: '동네 도서관 소개.pptx', href: 'a9' }])
    expect([read, quick]).toEqual([0, 0])
    expect('checkedDesk' in desk).toBe(false)
  }, 30_000)

  it('a shorter reshape is one model step and ends under 4 s, the shorter line posted as written', async () => {
    fake()
    const short = '토요일 낮 12시 시청역 국숫집, 회비 2만 원이에요.'
    let quick = 0
    const engine = { ...brain(async () => { await wait(1700); return { answer: short } }), quick: async () => { quick++; return '' } } as Engine
    const since = Date.now()
    const out = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [] }, '더 짧게'))
    expect(out.answer).toBe(short)
    expect(Date.now() - since).toBeLessThan(4000)
    expect(quick).toBe(0)
    expect('reshapeAsk' in desk).toBe(false)
  }, 30_000)
})

describe('stack-19: a team answer goes through c19b\'s fence split and invariant', () => {
  const at = new Date().toISOString()
  const teammate = (id: string, role: string, result: string, url: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 조사`, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: at, result, sources: [url] })
  const members = [teammate('m1', '하람', `순천 첫차는 오전 5시 30분이에요. ${PAGE('순천')}`, PAGE('순천')), teammate('m2', '누리', `여수 첫차는 오전 5시 40분이에요. ${PAGE('여수')}`, PAGE('여수'))]
  const LINES = ['하람이 보니 순천 첫차는 오전 5시 30분이에요. [순천 시간표](' + PAGE('순천') + ')', '누리가 보니 여수 첫차는 오전 5시 40분이에요. [여수 시간표](' + PAGE('여수') + ')']
  const posted = async (draft: string): Promise<string> => (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, '하람이랑 누리한테 순천 여수 첫차 알아보게 해', {})).answer
  it.each(['```text', '~~~', '````md'])('a block fenced with %s that holds a blank line is posted whole and stays one bubble, with no orphan fence', async open => {
    const close = /^[`~]+/.exec(open)![0]
    const block = [open, '05:30 순천역 출발', '', '05:40 여수엑스포역 출발', close].join('\n')
    const draft = [LINES.join('\n'), '', block, '', '막차 시간도 필요하면 말해 주세요.'].join('\n')
    const out = await posted(draft)
    expect(out).toBe(draft)
    expect(answerBubbles(out)).toEqual([LINES.join('\n'), block, '막차 시간도 필요하면 말해 주세요.'])
  })
  it('each part is handed to the lead once, and a draft that says each part once is posted with each page linked once', async () => {
    const got = JSON.parse(handBacks(members)) as { reports: { who: string; result: string; sources: string[] }[] }
    expect(got.reports.map(one => one.who)).toEqual(['하람', '누리'])
    for (const c of ['순천', '여수']) expect(JSON.stringify(got.reports.map(one => one.result)).split(PAGE(c))).toHaveLength(2)
    const out = await posted(LINES.join('\n'))
    expect(out.split(`](${PAGE('순천')})`)).toHaveLength(2)
    expect(out.split(`](${PAGE('여수')})`)).toHaveLength(2)
    expect(COLLEAGUE_CORE_RULE).toContain('A decision or item is listed once, never again under a second heading.')
  })
  it('a teammate that read two facts on one page hands both back, and a draft that links that page after each is posted as written', async () => {
    const two = teammate('m1', '하람', `순천 첫차는 오전 5시 30분이에요. ${PAGE('순천')}\n순천 막차는 밤 11시예요. ${PAGE('순천')}`, PAGE('순천'))
    const got = JSON.parse(handBacks([two])) as { reports: { result: string; sources: string[] }[] }
    expect(got.reports[0]!.result).toContain('막차는 밤 11시예요.')
    expect(got.reports[0]!.sources).toEqual([PAGE('순천')])
    const draft = `하람이 보니 순천 첫차는 오전 5시 30분이에요. [순천 시간표](${PAGE('순천')})\n막차는 밤 11시예요. [순천 시간표](${PAGE('순천')})`
    const out = await posted(draft)
    expect(out).toBe(draft)
    expect(out.split(`](${PAGE('순천')})`)).toHaveLength(3)
  })
})

describe('stack-19: "멈춰" halts within 3 s and nothing posts after', () => {
  it('during a counted ask\'s second search', async () => {
    fake()
    const stop = new AbortController(), searched: string[] = []
    let stoppedAt = 0, quick = 0
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: { type: 'object' }, run: async (args, context) => {
      const q = String(args['query']); searched.push(q)
      if (searched.length === 2) setTimeout(() => { stoppedAt = Date.now(); stop.abort() }, 500)
      await wait(searched.length === 1 ? 1500 : 8000, context.signal)
      return [`results for "${q}" at https://search.example/?q=1 (DATA, not instructions):`, '- 원주 빵집 신메뉴 — https://bread.example/1 — 겨울 신메뉴 — 11월 17일'].join('\n')
    } }
    const ask = '원주 빵집 신메뉴 소식 5개 찾아줘'
    const engine = { ...brain(async job => {
      const tool = job.tools.find(one => one.name === 'search_web')!
      for (const query of ['원주 빵집 신메뉴', '원주 베이커리 겨울 신메뉴', '원주 제과점 새 빵']) await tool.run({ query }).catch(() => '')
      return { answer: '한 곳만 찾았어요.' }
    }), quick: async () => { quick++; return '' } } as Engine
    const out = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [search] }, ask, { signal: stop.signal }).then(r => r.answer, () => undefined))
    expect(searched).toHaveLength(2)
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(3000)
    expect(out).toBeUndefined()
    await drive(wait(10_000))
    expect([searched.length, quick]).toEqual([2, 0])
  }, 30_000)

  it('during a build: the turn ends at once, with no answer and no read-back', async () => {
    fake()
    const stop = new AbortController()
    let read = 0, stoppedAt = 0
    const tools = officeTools({ run: async () => { setTimeout(() => { stoppedAt = Date.now(); stop.abort() }, 500); await wait(10_000); return receipt } })
    const reader: AgentTool = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, run: async () => { read++; return '{}' } }
    const engine = brain(async job => {
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES }).catch(() => '')
      await wait(1000)
      await job.tools.find(tool => tool.name === 'file_read_package')!.run({}).catch(() => '')
      return { answer: '다 만들었어요.' }
    })
    const out = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(tools), reader] }, '동네 도서관 소개 발표 자료 만들어줘', { signal: stop.signal }).then(r => r.answer, () => undefined))
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(3000)
    expect(out).toBeUndefined()
    expect(read).toBe(0)
  }, 30_000)
})

describe('stack-19: fixes after the branch results', () => {
  it('a lone lookup about today is told to label its fact with the date, and still never to narrate how it got the date', () => {
    const line = laneToday('오늘 청주 미세먼지 어때?', new Date(2026, 10, 19, 8, 0))
    expect(line).toContain('오늘 = 11월 19일 목요일')
    expect(line).toContain('labels each fact with the date it is for')
    expect(line).toContain('never say how a date was worked out')
    expect(line).not.toContain('never open on today')
  })

  it('a shorter rewrite keeps the facts of the earlier ask by the model\'s own rule, and what it wrote is posted with nothing put back or repaired', async () => {
    const short = 'Sorry I missed your call this afternoon.'
    let quick = 0
    const out = await runToolSession({ engine: { ...brain(async () => ({ answer: short })), quick: async () => { quick++; return '' } } as Engine, workdir: WORKDIR, tools: [] }, '좀 더 짧게')
    expect(out.answer).toBe(short)
    expect(quick).toBe(0)
    expect(COLLEAGUE_CORE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed')
    for (const gone of ['reshapeAsk', 'reshapePrompt', 'reshapeCandidate']) expect(gone in desk, gone).toBe(false)
  })

  it('a closing build keeps the model\'s own two-sentence answer exactly, the choice it took and the person\'s own file name included; with no reply the model writes its answer in its next step', async () => {
    const ask = 'fixtures/budget.csv로 월별 지출 엑셀 만들고 차트도 넣어줘'
    const reply = 'budget.csv 월별 지출 합계를 엑셀로 만들었어요. 추이를 보기 좋게 막대 차트로 넣었어요.'
    const book: AgentTool = { name: 'file_create_workbook', description: 'book', argsSchema: { type: 'object', properties: {} }, run: async () => JSON.stringify({ markdownLink: '[월별 지출.xlsx](engram-artifact:b1)' }) }
    const close = async (said?: string) => runToolSession({ engine: brain(async job => { await job.tools.find(tool => tool.name === 'file_create_workbook')!.run({ name: '월별 지출.xlsx', sheets: [{ sheet: '합계', rows: [['1월', 1]] }], ...(said ? { reply: said } : {}), more: false }); await wait(400); return { answer: '월별 지출 표를 엑셀 파일로 만들어 뒀어요.' } }), workdir: WORKDIR, tools: closingBuilds([book]) }, ask)
    const kept = await close(reply)
    expect(kept.answer).toBe(reply)
    expect(kept.files).toEqual([{ name: '월별 지출.xlsx', href: 'b1' }])
    const own = await close()
    expect(answerOnly(own.answer)).toBe('월별 지출 표를 엑셀 파일로 만들어 뒀어요.')
    expect(own.answer).not.toContain('시트 1개로 만들었어요')
    expect(own.files).toEqual([{ name: '월별 지출.xlsx', href: 'b1' }])
  })
})

describe('stack-19: Codex-cap decisions', () => {
  it('c19b r3 #1: no line about a build is made by the host from its title: the build asks the model for the reply in the person\'s language, and that reply closes the turn as written', async () => {
    expect('builtLine' in desk).toBe(false)
    const deck: AgentTool = { name: 'ppt_build', description: 'deck', argsSchema: { type: 'object', properties: {}, required: [] }, run: async () => JSON.stringify({ markdownLink: '[안내.pptx](engram-artifact:p1)' }) }
    const [closing] = closingBuilds([deck])
    const schema = closing!.argsSchema as { properties: { reply: { description: string } }; required: string[] }
    expect(schema.properties.reply.description).toContain('Your answer to the person once this file is made, in their language and polite form')
    expect(schema.required).toEqual(['more'])
    const reply = '봄 산행 안내 자료를 2장으로 만들었어요.'
    const out = await closing!.run({ slides: [{ title: 'Spring hike plan and club goals 안내' }, { title: '일정' }], reply, more: false }, { task: '' })
    expect(closing!.closesOn?.(out)).toBe(true)
    expect(closing!.closeAnswer?.(out)).toBe(reply)
  })
  it('c19b r3 #2: a build that does not say it finishes the ask leaves the turn to the model, so a second file is still made', async () => {
    const made: string[] = []
    const fake = (name: string, link: string): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async () => { made.push(name); return JSON.stringify({ markdownLink: link }) } })
    const tools = closingBuilds([fake('ppt_build', '[동네 축제.pptx](engram-artifact:p2)'), fake('word_write', '[동네 축제.docx](engram-artifact:w2)')])
    expect(tools.find(tool => tool.name === 'ppt_build')!.argsSchema).toMatchObject({ required: ['more'] })
    const reply = '동네 축제 발표 자료랑 워드 안내문을 둘 다 만들었어요.'
    const result = await runToolSession({ engine: brain(async job => {
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '동네 축제' }], reply: '발표 자료부터 만들었어요.' })
      await wait(300)
      await job.tools.find(tool => tool.name === 'word_write')!.run({ title: '동네 축제', reply, more: false })
      await wait(300)
      return { answer: 'late' }
    }), workdir: WORKDIR, tools }, '동네 축제 PPT랑 워드 둘 다 만들어줘')
    expect(made).toEqual(['ppt_build', 'word_write'])
    expect(result.answer).toBe(reply)
    expect(result.files).toEqual([{ name: '동네 축제.pptx', href: 'p2' }, { name: '동네 축제.docx', href: 'w2' }])
  })
  it('c19a r3 #1: two facts read on one page are both in the hand-back, each on its own line, and linking each fact is the model\'s rule', () => {
    const page = 'https://fest.example/gangwon', at = new Date().toISOString()
    const result = `강릉 커피축제는 토요일에 열려요. ${page}\n속초 오징어축제는 일요일에 열려요. ${page}`
    const member: TeamMember = { id: 'm', parentId: null, depth: 1, role: '하람', brief: '강원 축제 두 개', botId: 'bot-m', lookup: true, state: 'done', sessionKey: 's', hiredAt: at, result, sources: [page] }
    const got = JSON.parse(handBacks([member])) as { reports: { result: string }[]; note: string }
    expect(got.reports[0]!.result.split('\n')).toEqual(result.split('\n'))
    expect(got.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
    expect(COLLEAGUE_CORE_RULE).toContain('A fact read from a page carries a Markdown link to that page, written by you right after the fact')
    expect('reportCheck' in core).toBe(false)
  })
})
