import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import { answer, beginAnswer, openWorld } from '../src/main/answer.js'

const scratch: string[] = []
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'answer-test-')); scratch.push(dir); return dir }
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
const fake = (lead: (job: ToolSessionJob) => Promise<string>, quick?: (prompt: string) => Promise<string>): Engine => ({
  id: quick ? 'claude' : 'mock',
  desktopToolIsolation: true,
  ...(quick ? { quick } : {}),
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => ({ answer: await lead(job) }),
}) as unknown as Engine

describe('answer is the one entry the app and the runner share', () => {
  it('hands the app\'s persona, memory, history, notes and tool list to the engine call', async () => {
    let told = '', menu: string[] = []
    const engine = fake(async job => { told = [job.system, job.opening, job.prompt].join('\n'); menu = job.tools.map(tool => tool.name); return '반납일은 금요일이에요.' })
    const shelf: AgentTool = { name: 'shelf_lookup', description: 'finds a book on the shelf', argsSchema: { type: 'object' }, run: async () => '3층 서가' }
    const world = { ...await openWorld(await temp(), engine), history: [{ role: 'user' as const, text: '지난주에 빌린 책은 "바다의 지도"야' }, { role: 'assistant' as const, text: '"바다의 지도" 기억할게요.' }] }
    const { trace, result } = await answer(world, '그 책 반납일 언제야?', { tools: [shelf], persona: 'You are 하람, the reading-room helper.', memory: 'The person reads on the 3rd floor.', context: () => 'The library closes at 9.' })
    expect(told).toContain('하람, the reading-room helper')
    expect(told).toContain('The person reads on the 3rd floor.')
    expect(told).toContain('바다의 지도')
    expect(told).toContain('The library closes at 9.')
    expect(menu).toContain('shelf_lookup')
    expect(menu).not.toContain('search_web')
    expect(result?.answer).toBe('반납일은 금요일이에요.')
    expect(trace.final.text).toBe('반납일은 금요일이에요.')
  })

  it('shows the ack as the first text when it comes before the lead\'s answer, and the lead is told it is on screen', async () => {
    let told = ''
    const shown = vi.fn()
    const engine = fake(async job => { told = job.system + job.opening + job.prompt; await wait(80); job.onToken?.('대출 기록을 보니 반납일은 금요일이에요.'); return '대출 기록을 보니 반납일은 금요일이에요.' }, async prompt => prompt.includes('first line') ? '대출 기록부터 볼게요.' : 'NONE')
    const { trace } = await answer(await openWorld(await temp(), engine), '빌린 책 반납일 언제야?', { ack: { show: shown } })
    expect(trace.first?.text).toBe('대출 기록부터 볼게요.')
    expect(shown).toHaveBeenCalledExactlyOnceWith('대출 기록부터 볼게요.')
    expect(told).toContain('A short first line from you saying what you are starting on is already on screen')
    expect(trace.final.text).toBe('대출 기록을 보니 반납일은 금요일이에요.')
  })

  it('drops an ack that comes after the answer is done', async () => {
    const shown = vi.fn()
    const engine = fake(async () => '열람실은 밤 9시까지예요.', async () => { await wait(150); return '운영 시간부터 볼게요.' })
    const { trace } = await answer(await openWorld(await temp(), engine), '열람실 몇 시까지 열어?', { ack: { show: shown } })
    await wait(250)
    expect(shown).not.toHaveBeenCalled()
    expect(trace.first?.text).toBe('열람실은 밤 9시까지예요.')
  })

  it('shows the waiting line the app shows when the quick voice is slow, and holds the lead\'s words behind it', async () => {
    const shown = vi.fn(), held: boolean[] = []
    const engine = fake(async job => { await wait(1500); job.onToken?.('신간은 세 권이에요.'); return '신간은 세 권이에요.' }, async () => { await wait(1450); return '신간 목록부터 볼게요.' })
    const { trace } = await answer(await openWorld(await temp(), engine), '이번 주 신간 몇 권이야?', { ack: { show: shown }, onToken: (_, hold) => { held.push(hold) } })
    expect(shown).toHaveBeenCalledOnce()
    expect(trace.first?.text).toBe(shown.mock.calls[0]![0])
    expect(trace.first!.ms).toBeLessThan(1450)
    expect(held).toEqual([true])
  })

  it('streams the lead\'s words as the first text when no ack is wanted', async () => {
    const engine = fake(async job => { await wait(30); job.onToken?.('반가워요, 오늘도 잘 부탁드려요.'); await wait(30); return '반가워요, 오늘도 잘 부탁드려요.' }, async () => '사서 업무부터 볼게요.')
    const held: boolean[] = []
    const { trace } = await answer(await openWorld(await temp(), engine), '사서님 안녕하세요', { ack: { interactive: false }, onToken: (_, hold) => { held.push(hold) } })
    expect(held).toEqual([false])
    expect(trace.first?.text).toBe('반가워요, 오늘도 잘 부탁드려요.')
    expect(trace.first!.ms).toBeLessThan(trace.final.ms)
  })

  it('answers from the quick voice when the app asks for a whole answer, and the lead never runs', async () => {
    const lead = vi.fn(async () => '쓰이면 안 돼요.')
    const engine = fake(lead, async prompt => prompt.includes('short question') ? '한 시간은 3,600초예요.' : 'NONE')
    const { result } = await answer(await openWorld(await temp(), engine), '한 시간은 몇 초야?', { ack: { whole: true } })
    expect(result?.answer).toBe('한 시간은 3,600초예요.')
    expect(lead).not.toHaveBeenCalled()
  })

  it('hands a failed lead step back as the failure, with the trace kept', async () => {
    const engine = fake(async () => { throw new Error('서가 정리 중') })
    const { trace, result, failure } = await answer(await openWorld(await temp(), engine), '신간 목록 보여줘')
    expect(result).toBeUndefined()
    expect(failure).toBeInstanceOf(Error)
    expect(trace.error).toBe('서가 정리 중')
  })

  it('gives a lookup ask the same menu and call shape as any other ask, and runs no search before the model', async () => {
    const jobs: { tools: string[]; maxCalls: number; modelHint?: string; effort?: string; searchedBefore: number }[] = []
    let searches = 0
    const engine = fake(async job => { jobs.push({ tools: job.tools.map(tool => tool.name), maxCalls: job.maxCalls, ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}), searchedBefore: searches }); return '알아봤어요.' })
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async () => { searches++; return 'results for "x"\n1. x' } }
    const open: AgentTool = { name: 'open_page', description: 'opens a page', argsSchema: { type: 'object' }, run: async () => 'page' }
    const shelf: AgentTool = { name: 'shelf_lookup', description: 'finds a book on the shelf', argsSchema: { type: 'object' }, run: async () => '3층 서가' }
    for (const ask of ['오사카 이번 주말 비 소식 좀 찾아봐 줄래', '어제 나스닥 마감 시세랑 엔화 환율 알아봐 줘', '봇 두 개 써서 성수동 팝업이랑 연남동 전시 따로 조사해줘', '탕비실 커피머신 세척 순서 정리해 볼래'])
      await answer(await openWorld(await temp(), engine), ask, { plainAsk: true, tools: [search, open, shelf], maxCalls: 12 })
    expect(searches).toBe(0)
    expect(jobs).toHaveLength(4)
    for (const job of jobs) expect(job).toEqual(jobs[3])
    expect(jobs[0]!.tools.slice(0, 3)).toEqual(['search_web', 'open_page', 'shelf_lookup'])
    expect(jobs[0]!.maxCalls).toBe(12)
  })

  it('gives a lookup ask the quick model\'s own ack, like any other ask', async () => {
    const shown: string[] = []
    const engine = fake(async () => '오사카는 토요일 오후에 비가 와요.', async prompt => prompt.includes('first line') ? '오사카 주말 예보부터 볼게요.' : 'NONE')
    const { trace } = await answer(await openWorld(await temp(), engine), '오사카 이번 주말 비 소식 좀 찾아봐 줄래', { ack: { show: line => { shown.push(line) } } })
    expect(shown).toEqual(['오사카 주말 예보부터 볼게요.'])
    expect(trace.first?.text).toBe('오사카 주말 예보부터 볼게요.')
  })

  it('keeps no lane, first search or swap round in answer or ipc', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const own = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')
    for (const file of [ipc, own]) expect(file).not.toMatch(/fastLane|firstSearch|swapRounds|laneToday|\bLANE_|laneSearches|laneChanged|searchFor|keepRead|skipWalls|lookup: true/)
    expect(own.indexOf('beginFirstLine({')).toBeLessThan(own.indexOf('const run = async'))
  })

  it('ipc makes a bot\'s answer through answer, with no runComet call of its own', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).not.toMatch(/\brunComet\b/)
    expect(ipc).not.toMatch(/beginFirstLine|endFirstLine|firstLineReady/)
    expect(ipc).toContain('const begun = bot ? beginAnswer({ paths, botId: bot.id, engine: team.leadEngine(channel, engine),')
    expect(ipc).toContain('await begun!.run({')
  })

  it('keeps the ack on screen through slow work the caller does between beginning and running, and the run keeps it as the first text', async () => {
    const shown: number[] = [], started = performance.now()
    const engine = fake(async () => '영수증은 달별로 나눠 뒀어요.', async () => '영수증부터 달별로 나눌게요.')
    const world = await openWorld(await temp(), engine)
    const begun = beginAnswer(world, '영수증 폴더 달별로 나눠줘', { ack: { show: () => { shown.push(performance.now() - started) } } })
    await wait(450)
    expect(shown).toHaveLength(1)
    expect(shown[0]!).toBeLessThan(450)
    const { trace, result } = await begun.run()
    begun.end()
    expect(trace.first?.text).toBe('영수증부터 달별로 나눌게요.')
    expect(result?.answer).toBe('영수증은 달별로 나눠 뒀어요.')
    expect(shown).toHaveLength(1)
  })

  it('ipc begins the answer before any setup or quick path that can take time, and ends it when the turn is released', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const turn = ipc.slice(ipc.indexOf('async function handleChatSend('))
    const begin = turn.indexOf('beginAnswer(')
    for (const work of ['buildRetrievedContext(', 'readChatAttachments(', 'await cometToolSet({ channel, engine, settings, permission', 'await skillShortlist(', 'await begun!.run({'])
      expect(turn.indexOf(work), work).toBeGreaterThan(begin)
    const own = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8'), run = own.indexOf('const run = async')
    for (const work of ['await namedText(', 'keptFix(', 'plainKeep(', 'await fixSlideTitle(', 'await sortByKind(', 'await skills()']) expect(own.indexOf(work), work).toBeGreaterThan(run)
    expect(ipc).toMatch(/for \(const ack of acks\) ack\.end\(\)/)
  })
})
