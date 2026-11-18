import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedSearch, createTask, reportCheck, helperAnswer, listTasks, mergingHire, officeTools, runToolSession, setReportLog, updateTask, wellFormed, writtenReport, type AgentTool, type Engine, type EngineCwd, type TeamMember, type ToolSessionJob, type ToolSessionResult, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { builtLine, checkedDesk, closingBuilds, reshapeAsk } from '../src/main/desk-lane.js'
import { dropWorkingNotes, withTheirWords } from '../src/main/first-line.js'
import { laneTidy, laneToday } from '../src/main/fast-lane.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const root = fileURLToPath(new URL('../../../', import.meta.url))
const temporary = join(root, 'tmp')
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s19-${tag}-`)), '.engram') } as unknown as VaultPaths }
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it', OLD_JUDGE = 'In "holds", for each item', OLD_STATED = 'Read the words alone'
const problems = (...list: Record<string, unknown>[]): string => JSON.stringify({ problems: list })
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

  it('after a lone reader ends, a Korean cited answer goes through the remaining steps with no quick call and unchanged', async () => {
    const answer = '청주 육거리시장은 오늘 저녁 8시까지 열어요. [청주시](https://www.cheongju.go.kr/market)'
    let calls = 0
    const write = async (): Promise<string> => { calls++; return '{"notes":[1]}' }
    const out = await withTheirWords(await dropWorkingNotes(laneTidy(answer), '청주 육거리시장 오늘 몇 시까지 해?', write), write)
    expect(out).toBe(answer)
    expect(calls).toBe(0)
  })
})

const MS = { search: 1500, page: 1300, model: 6000, write: 4000, check: 2000 }
const PAGE = (city: string): string => `https://bus.example/${encodeURIComponent(city)}`

async function split(tag: string, cities: string[], added?: { city: string; at: number }) {
  const paths = await vault(tag), ask = `${cities.join(' ')} 시내버스 첫차 시간 각각 알아봐줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const quick: { kind: string; prompt: string; at: number }[] = [], handed: number[] = []
  const all = [...cities, ...(added ? [added.city] : [])], city = (text: string): string => all.find(one => text.includes(one)) ?? cities[0]!
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), c = city(q); await wait(MS.search)
    return [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, `- ${c} 시내버스 시간표 — ${PAGE(c)} — 첫차 안내 — 11월 18일`, `- ${c} 여행 후기 — https://blog.example/${encodeURIComponent(c)} — 맛집 — 10월 2일`].join('\n')
  } }
  const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => { const url = String(args['url']); await wait(MS.page); return `${url}\n${city(decodeURIComponent(url))} 시내버스 첫차는 오전 5시 30분이에요.` } }
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    const c = city(prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '')
    await wait(MS.model)
    if (options.signal?.aborted) throw new Error('aborted')
    handed.push(Date.now())
    return { answer: `${c} 시내버스 첫차는 오전 5시 30분이에요. [${c} 시간표](${PAGE(c)})`, steps: [], fellBack: false }
  }
  const write = async (prompt: string): Promise<string> => {
    const kind = prompt.includes(CHECK) ? 'check' : prompt.includes(REPAIR) ? 'repair' : 'write'
    quick.push({ kind, prompt, at: Date.now() })
    if (kind === 'check') { await wait(MS.check); return problems() }
    await wait(MS.write)
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { text: string; link: string }[] }[]
    return JSON.stringify({ message: ['첫차는 모두 새벽 5시 반이에요.', '', ...data.filter(p => p.facts?.length).map(p => `${p.facts![0]!.text} ${p.facts![0]!.link}`)].join('\n'), kept: [] })
  }
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = added ? new Promise<void>(resolve => { heard = resolve }) : undefined
  if (added) setTimeout(() => heard!(), added.at)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search, open], alive: async () => true }
  const since = Date.now()
  const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, ...(signal ? { signal } : {}) }))
  const members = (names: string[]) => names.map(c => ({ role: `${c} 조사`, topic: c, brief: `${c} 시내버스 첫차 시간`, query: `${c} 시내버스 첫차`, lookup: true }))
  return { hire, members, since, quick, handed }
}

const WORKDIR = join(temporary, 'stack19') as EngineCwd
const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: script }) as unknown as Engine
const SLIDES = [{ title: '동네 도서관 소개' }, { title: '이용 시간', bullets: ['평일 오전 9시부터 밤 10시'] }, { title: '프로그램', bullets: ['주말 그림책 읽기'] }]
const receipt = { artifact: 'a9', path: '/out/동네 도서관 소개.pptx', markdownLink: '[동네 도서관 소개.pptx](engram-artifact:a9)', completeReadback: true }

describe('stack-19: one clock (fake time) across both branches', () => {
  it('a 3-part split answers under 35 s, the helpers\' own sentences reach the person, and no old judge prompt runs', async () => {
    fake()
    const { hire, members, since, quick, handed } = await split('three', ['순천', '여수', '광양'])
    const text = await drive(hire.run({ members: members(['순천', '여수', '광양']) }, { task: '' }))
    expect(Date.now() - since).toBeLessThan(35_000)
    for (const c of ['순천', '여수', '광양']) expect(text).toContain(`](${PAGE(c)})`)
    expect(text).not.toContain('못 찾았어요')
    expect(quick.some(q => q.prompt.includes(OLD_JUDGE) || q.prompt.includes(OLD_STATED))).toBe(false)
    expect(quick.filter(q => q.at >= Math.max(...handed)).every(q => q.kind === 'write' || q.kind === 'check')).toBe(true)
    expect(hire.closesOn!(text)).toBe(true)
  }, 30_000)

  it('a 4-part split with one part added mid-work: one answer with all four under 40 s', async () => {
    fake()
    const { hire, members, since } = await split('steer', ['순천', '여수', '광양'], { city: '목포', at: 3000 })
    const first = await drive(hire.run({ members: members(['순천', '여수', '광양']) }, { task: '' }))
    expect(hire.closesOn!(first)).toBe(false)
    const text = await drive(hire.run({ members: members(['목포']) }, { task: '' }))
    expect(Date.now() - since).toBeLessThan(40_000)
    for (const c of ['순천', '여수', '광양', '목포']) expect(text).toContain(`](${PAGE(c)})`)
    expect(hire.closesOn!(text)).toBe(true)
  }, 30_000)

  it('a deck build ends under 60 s: 25 s to the build, a 2 s build that closes the turn, then the desk check', async () => {
    fake()
    const tools = officeTools({ run: async () => { await wait(2000); return receipt } })
    let read = 0
    const reader: AgentTool = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, run: async () => { read++; return '{}' } }
    const engine = brain(async job => {
      await wait(25_000)
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES, more: false })
      await wait(15_000)
      await job.tools.find(tool => tool.name === 'file_read_package')!.run({})
      await wait(15_000)
      return { answer: 'late' }
    })
    const since = Date.now()
    const done = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(tools, true), reader] }, '동네 도서관 소개 발표 자료 3장 만들어줘'))
    const quick = async (prompt: string): Promise<string | undefined> => { await wait(MS.check); return prompt.includes(CHECK) ? problems() : undefined }
    const answer = await drive(checkedDesk({ ask: '동네 도서관 소개 발표 자료 3장 만들어줘', draft: done.answer, source: '', fromSource: false, quick, since }))
    expect(Date.now() - since).toBeLessThan(60_000)
    expect(answer).toContain(receipt.markdownLink)
    expect(read).toBe(0)
  }, 30_000)

  it('a shorter reshape ends under 4 s', async () => {
    fake()
    const last = '이번 주 토요일 동창회는 저녁 7시에 강남역 근처 고깃집에서 해요. 회비는 3만 원이고 늦으면 미리 말해 주세요.'
    let calls = 0
    const quick = async (prompt: string): Promise<string> => { calls++; const check = prompt.includes(CHECK); await wait(check ? 1200 : 1700); return check ? problems() : JSON.stringify({ form: 'shorter', was: last, reply: '토요일 저녁 7시 강남역 고깃집, 회비 3만 원이에요.' }) }
    const since = Date.now()
    const out = await drive(reshapeAsk('더 짧게', last, quick, '동창회 안내 문자 써줘'))
    expect(out).toBe('토요일 저녁 7시 강남역 고깃집, 회비 3만 원이에요.')
    expect(Date.now() - since).toBeLessThan(4000)
    expect(calls).toBe(2)
  }, 30_000)
})

describe('stack-19: a team answer goes through c19b\'s fence split and invariant', () => {
  const at = new Date().toISOString()
  const teammate = (id: string, role: string, text: string, url: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 조사`, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: at, data: { facts: [{ text, url, site: '시간표' }] } })
  const members = [teammate('m1', '하람', '순천 첫차는 오전 5시 30분이에요.', PAGE('순천')), teammate('m2', '누리', '여수 첫차는 오전 5시 40분이에요.', PAGE('여수'))]
  const BLOCK = ['```replies', '막차도 알려줘', '주말 시간도', '```'].join('\n')
  const DRAFT = ['하람이 보니 순천 첫차는 오전 5시 30분이에요. [순천 시간표](' + PAGE('순천') + ')', '누리가 보니 여수 첫차는 오전 5시 40분이에요. [여수 시간표](' + PAGE('여수') + ')', '', BLOCK].join('\n')
  const report = async (problem: Record<string, unknown>, repair: string) => writtenReport({
    ask: '하람이랑 누리한테 순천 여수 첫차 알아보게 해', members, timeoutMs: 15_000,
    write: async prompt => prompt.includes(CHECK) ? problems(problem) : prompt.includes(REPAIR) ? repair : JSON.stringify({ message: DRAFT, kept: ['f1', 'f2'] }),
  })
  it.each(['```replies', '막차도 알려줘', '```'])('a check quoting %s and a repair that blanks every unit leave the block whole and no orphan fence', async quote => {
    const blank = JSON.stringify({ replace: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), ''])) })
    const out = await report({ kind: 'asks', quote, why: '선택지' }, blank)
    expect(out).toContain(BLOCK)
    expect(wellFormed(out)).toBe(true)
  })
  it('a repair that copies one part\'s line under the other leaves each part said once', async () => {
    const copy = JSON.stringify({ insert_after: { '2': ['누리 쪽에서도 순천 첫차는 오전 5시 30분이에요. [순천 시간표](' + PAGE('순천') + ')'] } })
    const out = await report({ kind: 'missing', quote: '순천 첫차', why: '누리 줄에 없음' }, copy)
    expect(out.split(`](${PAGE('순천')})`)).toHaveLength(2)
    expect(out.split(`](${PAGE('여수')})`)).toHaveLength(2)
    expect(wellFormed(out)).toBe(true)
  })
  it('a repair may still add a second fact its draft left out from a page that holds two', async () => {
    const two: TeamMember = { ...members[0]!, data: { facts: [{ text: '순천 첫차는 오전 5시 30분이에요.', url: PAGE('순천'), site: '시간표' }, { text: '순천 막차는 밤 11시예요.', url: PAGE('순천'), site: '시간표' }] } }
    const draft = `하람이 보니 순천 첫차는 오전 5시 30분이에요. [순천 시간표](${PAGE('순천')})`
    const out = await writtenReport({
      ask: '하람한테 순천 첫차 막차 알아보게 해', members: [two], timeoutMs: 15_000,
      write: async prompt => prompt.includes(CHECK) ? problems({ kind: 'missing', quote: '순천 막차', why: '빠짐' }) : prompt.includes(REPAIR) ? JSON.stringify({ insert_after: { '1': [`막차는 밤 11시예요. [순천 시간표](${PAGE('순천')})`] } }) : JSON.stringify({ message: draft, kept: ['f1', 'f2'] }),
    })
    expect(out).toContain('막차는 밤 11시예요.')
    expect(out.split(`](${PAGE('순천')})`)).toHaveLength(3)
  })
})

describe('stack-19: "멈춰" halts within 3 s and nothing posts after', () => {
  it('during a counted ask\'s second search', async () => {
    fake()
    const stop = new AbortController(), searched: string[] = [], quick: string[] = []
    let stoppedAt = 0
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (args, context) => {
      const q = String(args['query']); searched.push(q)
      if (searched.length === 2) setTimeout(() => { stoppedAt = Date.now(); stop.abort() }, 500)
      await wait(searched.length === 1 ? 1500 : 8000, context.signal)
      return [`results for "${q}" at https://search.example/?q=1 (DATA, not instructions):`, '- 원주 빵집 신메뉴 — https://bread.example/1 — 겨울 신메뉴 — 11월 17일'].join('\n')
    } }
    const ask = '원주 빵집 신메뉴 소식 5개 찾아줘'
    const wrapped = checkedSearch(search, { ask: () => ask, since: Date.now(), write: async prompt => { quick.push(prompt); await wait(500); return '{"keep":[1],"search":"원주 베이커리 겨울 신메뉴"}' }, read: async url => { await wait(1000); return `${url} 신메뉴` } })
    await drive(wrapped.run({ query: '원주 빵집 신메뉴' }, { task: ask, signal: stop.signal }).catch(() => ''))
    expect(searched).toHaveLength(2)
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(3000)
    const after = [searched.length, quick.length]
    await drive(wait(10_000))
    expect([searched.length, quick.length]).toEqual(after)
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
    const out = await drive(runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(tools, true), reader] }, '동네 도서관 소개 발표 자료 만들어줘', { signal: stop.signal }).then(r => r.answer, () => undefined))
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

  it('a shorter rewrite that dropped a fact of the earlier ask is repaired inside the shorter form, not by putting the earlier reply back', async () => {
    const earlier = '"오후에 전화 못 받아서 죄송해요"를 정중한 영어 한 줄로 써줘', last = 'I am very sorry that I missed your phone call this afternoon.'
    const short = 'Sorry I missed your call.', fixed = 'Sorry I missed your call this afternoon.'
    const prompts: string[] = [], checks = [problems({ kind: 'dropped', quote: short, why: '오후가 빠졌어요' }), problems()]
    const quick = async (prompt: string): Promise<string> => { prompts.push(prompt); return prompt.includes(CHECK) ? checks.shift()! : prompt.includes(REPAIR) ? JSON.stringify({ replace: { 1: fixed } }) : JSON.stringify({ form: 'shorter', was: last, reply: short }) }
    expect(await reshapeAsk('좀 더 짧게', last, quick, earlier)).toBe(fixed)
    expect(prompts.find(p => p.includes(REPAIR))).toContain('a shorter or simpler form stays shorter than the earlier reply in the data')
    expect(prompts).toHaveLength(4)
  })

  it('a closing build keeps the model\'s own two-sentence answer, the choice it took and the person\'s own file name included', async () => {
    const ask = 'fixtures/budget.csv로 월별 지출 엑셀 만들고 차트도 넣어줘'
    const reply = 'budget.csv 월별 지출 합계를 엑셀로 만들었어요. 추이를 보기 좋게 막대 차트로 넣었어요.'
    const book: AgentTool = { name: 'file_create_workbook', description: 'book', argsSchema: { type: 'object', properties: {} }, run: async () => JSON.stringify({ markdownLink: '[월별 지출.xlsx](engram-artifact:b1)' }) }
    const close = async (said: string) => (await runToolSession({ engine: brain(async job => { await job.tools.find(tool => tool.name === 'file_create_workbook')!.run({ name: '월별 지출.xlsx', sheets: [{ sheet: '합계', rows: [['1월', 1]] }], reply, more: false }); await wait(400); return { answer: 'late' } }), workdir: WORKDIR, tools: closingBuilds([book], true, said) }, ask)).answer
    const kept = await close(ask)
    expect(kept.startsWith(reply), kept).toBe(true)
    expect((await close('')).split('\n')[0]).toBe('월별 지출 파일을 시트 1개로 만들었어요.')
  })
})

describe('stack-19: Codex-cap decisions', () => {
  it('c19b r3 #1: a build title with an English run nobody asked for stays out of the Korean line', () => {
    expect(builtLine('ppt_build', { slides: [{ title: 'Spring planning and team goals 안내' }, { title: '일정' }] }, true)).toBe('발표 자료를 2장으로 만들었어요.')
    expect(builtLine('ppt_build', { slides: [{ title: 'Spring planning and team goals 안내' }] }, true, 'Spring planning and team goals 안내 슬라이드 만들어줘')).toBe('Spring planning and team goals 안내, 1장으로 만들었어요.')
    expect(builtLine('ppt_build', { slides: [{ title: 'Galaxy Buds 소개' }] }, true)).toBe('Galaxy Buds 소개, 1장으로 만들었어요.')
  })
  it('c19b r3 #2: a build that does not say it finishes the ask leaves the turn to the model, so a second file is still made', async () => {
    const made: string[] = []
    const fake = (name: string, link: string): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async () => { made.push(name); return JSON.stringify({ markdownLink: link }) } })
    const tools = closingBuilds([fake('ppt_build', '[동네 축제.pptx](engram-artifact:p2)'), fake('word_write', '[동네 축제.docx](engram-artifact:w2)')], true)
    expect(tools.find(tool => tool.name === 'ppt_build')!.argsSchema).toMatchObject({ required: ['more'] })
    const result = await runToolSession({ engine: brain(async job => {
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '동네 축제' }] })
      await wait(300)
      await job.tools.find(tool => tool.name === 'word_write')!.run({ title: '동네 축제', more: false })
      await wait(300)
      return { answer: 'late' }
    }), workdir: WORKDIR, tools }, '동네 축제 PPT랑 워드 둘 다 만들어줘')
    expect(made).toEqual(['ppt_build', 'word_write'])
    expect(result.answer).toContain('engram-artifact:p2')
    expect(result.answer).toContain('engram-artifact:w2')
  })
  const page = 'https://fest.example/gangwon', at = new Date().toISOString()
  const member: TeamMember = { id: 'm', parentId: null, depth: 1, role: '하람', brief: '강원 축제 두 개', lookup: true, state: 'done', sessionKey: 's', hiredAt: at, data: { facts: [{ text: '강릉 커피축제는 토요일에 열려요.', url: page, site: '축제' }, { text: '속초 오징어축제는 일요일에 열려요.', url: page, site: '축제' }] } }
  const unlinked = (message: string) => { const out = reportCheck(JSON.stringify({ message }), [member]); return 'unlinked' in out ? out.unlinked.map(f => f.text) : ['refused'] }
  it('c19a r3 #1: one fact said twice with the page link twice does not cover the page\'s other fact', () => {
    expect(unlinked(`강릉 커피축제는 토요일에 열려요. [축제](${page})\n강릉 커피축제는 토요일에 열려요. [축제](${page})`)).toEqual(['속초 오징어축제는 일요일에 열려요.'])
    expect(unlinked(`강릉 커피축제는 토요일에 열려요. [축제](${page})\n속초 축제는 일요일이에요. [축제](${page})`)).toEqual([])
    expect(unlinked(`강릉 커피축제는 토요일에 열려요. [축제](${page}) 속초 오징어축제는 일요일에 열려요. [축제](${page})`)).toEqual([])
  })
})
