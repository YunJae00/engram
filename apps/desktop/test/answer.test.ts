import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, Engine, QuickReply, ToolSessionJob } from 'core'
import { answer, beginAnswer, openWorld } from '../src/main/answer.js'

const scratch: string[] = []
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'answer-test-')); scratch.push(dir); return dir }
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
const fake = (lead: (job: ToolSessionJob) => Promise<string>, quick?: (prompt: string) => Promise<QuickReply>): Engine => ({
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
    const { trace, result } = await answer(world, '그 책 반납일 언제야?', { tools: [shelf], persona: 'You are 하람, the reading-room helper.', memory: 'The person reads on the 3rd floor.', context: () => ({ turn: 'The library closes at 9.' }) })
    expect(told).toContain('하람, the reading-room helper')
    expect(told).toContain('The person reads on the 3rd floor.')
    expect(told).toContain('바다의 지도')
    expect(told).toContain('The library closes at 9.')
    expect(menu).toContain('shelf_lookup')
    expect(menu).not.toContain('search_web')
    expect(result?.answer).toBe('반납일은 금요일이에요.')
    expect(trace.final.text).toBe('반납일은 금요일이에요.')
  })

  it('shows the quick tier\'s first line before the work lead starts; the lead is told the line and works from the person\'s own words, and the brief goes only to the trace', async () => {
    let told = ''
    const shown = vi.fn()
    const engine = fake(async job => { told = job.system + job.opening + job.prompt; await wait(80); job.onToken?.('대출 기록을 보니 반납일은 금요일이에요.'); return '대출 기록을 보니 반납일은 금요일이에요.' }, async () => ({ text: '대출 기록부터 볼게요.', handOff: '빌린 책 반납일 확인' }))
    const { trace } = await answer(await openWorld(await temp(), engine), '빌린 책 반납일 언제야?', { ack: { show: shown } })
    expect(trace.first?.text).toBe('대출 기록부터 볼게요.')
    expect(shown).toHaveBeenCalledExactlyOnceWith('대출 기록부터 볼게요.')
    expect(told).toContain('The person has already been shown this first line from you: "대출 기록부터 볼게요."')
    expect(told).not.toContain('빌린 책 반납일 확인')
    expect(told).toContain('빌린 책 반납일 언제야?')
    expect(trace.brief).toBe('빌린 책 반납일 확인')
    expect(trace.final.text).toBe('대출 기록을 보니 반납일은 금요일이에요.')
  })

  it('starts the work lead only once the quick tier has handed off, so its line is never dropped for the lead\'s words', async () => {
    const shown = vi.fn()
    let startedAt = 0
    const begun = performance.now()
    const engine = fake(async () => { startedAt = performance.now() - begun; return '열람실은 밤 9시까지예요.' }, async () => { await wait(150); return { text: '운영 시간부터 볼게요.', handOff: '열람실 운영 시간' } })
    const { trace } = await answer(await openWorld(await temp(), engine), '열람실 몇 시까지 열어?', { ack: { show: shown } })
    expect(startedAt).toBeGreaterThanOrEqual(140)
    expect(shown).toHaveBeenCalledExactlyOnceWith('운영 시간부터 볼게요.')
    expect(trace.first?.text).toBe('운영 시간부터 볼게요.')
    expect(trace.final.text).toBe('열람실은 밤 9시까지예요.')
  })

  it('shows the waiting line at 1.5 s when the quick tier is slow, and the lead\'s words stream after it', async () => {
    const shown = vi.fn(), held: boolean[] = []
    const engine = fake(async job => { job.onToken?.('신간은 세 권이에요.'); return '신간은 세 권이에요.' }, async () => { await wait(1600); return { text: '신간 목록부터 볼게요.', handOff: '이번 주 신간 수' } })
    const { trace } = await answer(await openWorld(await temp(), engine), '이번 주 신간 몇 권이야?', { ack: { show: shown }, onToken: (_, hold) => { held.push(hold) } })
    expect(shown).toHaveBeenCalledOnce()
    expect(trace.first?.text).toBe(shown.mock.calls[0]![0])
    expect(trace.first!.ms).toBeGreaterThanOrEqual(1490)
    expect(trace.first!.ms).toBeLessThan(1600)
    expect(held).toEqual([false])
  })

  it('streams the lead\'s words as the first text when no ack is wanted', async () => {
    const engine = fake(async job => { await wait(30); job.onToken?.('반가워요, 오늘도 잘 부탁드려요.'); await wait(30); return '반가워요, 오늘도 잘 부탁드려요.' }, async () => ({ text: '사서 업무부터 볼게요.', handOff: '인사' }))
    const held: boolean[] = []
    const { trace } = await answer(await openWorld(await temp(), engine), '사서님 안녕하세요', { ack: { interactive: false }, onToken: (_, hold) => { held.push(hold) } })
    expect(held).toEqual([false])
    expect(trace.first?.text).toBe('반가워요, 오늘도 잘 부탁드려요.')
    expect(trace.first!.ms).toBeLessThan(trace.final.ms)
  })

  it('a quick reply with no hand-off is the whole answer: one quick call, no lead step, no line shown', async () => {
    const quick = vi.fn(async () => ({ text: '한 시간은 3,600초예요.' }))
    const lead = vi.fn(async () => '쓰이면 안 돼요.')
    const engine = fake(lead, quick)
    const shown: string[] = []
    const { result, trace } = await answer(await openWorld(await temp(), engine), '한 시간은 몇 초야?', { ack: { show: line => { shown.push(line) } } })
    expect(quick).toHaveBeenCalledOnce()
    expect(lead).not.toHaveBeenCalled()
    expect(shown).toEqual([])
    expect(result?.answer).toBe('한 시간은 3,600초예요.')
    expect(trace.first?.text).toBe('한 시간은 3,600초예요.')
    expect(trace.steps).toEqual([])
  })

  it('a recall the thread already holds is answered whole by the quick tier, which sees the conversation, before the safety time', async () => {
    const quick = vi.fn<(prompt: string) => Promise<QuickReply>>(async () => { await wait(10); return { text: '토요일 2시예요.' } })
    const lead = vi.fn(async () => '쓰이면 안 돼요.')
    const engine = fake(lead, quick)
    const world = { ...await openWorld(await temp(), engine), history: [{ role: 'user' as const, text: '치과 예약 금요일 3시야' }, { role: 'assistant' as const, text: '알겠어요.' }, { role: 'user' as const, text: '아 금요일 말고 토요일 2시로 옮겼어' }, { role: 'assistant' as const, text: '토요일 2시로 고쳤어요.' }] }
    const shown: string[] = []
    const { trace } = await answer(world, '치과 언제 가더라?', { ack: { show: line => { shown.push(line) } } })
    await wait(50)
    expect(quick.mock.calls[0]![0]).toContain('아 금요일 말고 토요일 2시로 옮겼어')
    expect(lead).not.toHaveBeenCalled()
    expect(shown).toEqual([])
    expect(trace.first?.text).toBe('토요일 2시예요.')
    expect(trace.first?.ms).toBeLessThan(1500)
  })

  it('a quick call that fails leaves the turn to the work lead, whose words are the first text', async () => {
    const quick = vi.fn(async (): Promise<QuickReply> => { await wait(20); throw new Error('The voice closed.') })
    const engine = fake(async job => { job.onToken?.('신간은 세 권이에요.'); return '신간은 세 권이에요.' }, quick)
    const shown: string[] = []
    const { trace } = await answer(await openWorld(await temp(), engine), '이번 주 들어온 신간 몇 권이야', { ack: { show: line => { shown.push(line) } } })
    expect(shown).toEqual([])
    expect(trace.first?.text).toBe('신간은 세 권이에요.')
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
      await answer(await openWorld(await temp(), engine), ask, { tools: [search, open, shelf], maxCalls: 12 })
    expect(searches).toBe(0)
    expect(jobs).toHaveLength(4)
    for (const job of jobs) expect(job).toEqual(jobs[3])
    expect(jobs[0]!.tools.slice(0, 3)).toEqual(['search_web', 'open_page', 'shelf_lookup'])
    expect(jobs[0]!.maxCalls).toBe(12)
  })

  it('gives a deck, a note, a file question, a correction and a plain telling the same menu and call shape: no model hint, no light effort, no shorter turn, no file read for the model', async () => {
    const jobs: { tools: string[]; maxCalls: number; modelHint?: string; effort?: string; system: string }[] = [], prompts: string[] = []
    const engine = fake(async job => { jobs.push({ tools: job.tools.map(tool => tool.name), maxCalls: job.maxCalls, ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}), system: job.system }); prompts.push(job.prompt); return '했어요.' })
    const reader: AgentTool = { name: 'file_read', description: 'reads a file', argsSchema: { type: 'object' }, run: async () => 'unused' }
    const build: AgentTool = { name: 'ppt_build', description: 'builds a deck', argsSchema: { type: 'object' }, run: async () => 'unused' }
    const dir = await temp()
    const world = await openWorld(dir, engine)
    await writeFile(join(world.paths.workspace, 'kitchen-duty.md'), '- 월: 설거지 담당 민서')
    for (const ask of ['신입 교육 일정 슬라이드 다섯 장 만들어줘', 'kitchen-duty.md 요약해줘', 'budget-q4.csv에서 총합 얼마야?', '아니 그거 말고 엑셀로', '오늘 드디어 이사 끝냈어'])
      await answer({ ...world, history: [] }, ask, { tools: [reader, build], maxCalls: 12 })
    expect(jobs).toHaveLength(5)
    for (const job of jobs) expect(job).toEqual({ tools: ['file_read', 'ppt_build', 'escalate'], maxCalls: 12, system: jobs[0]!.system })
    expect(prompts.join('\n')).not.toContain('설거지 담당 민서')
  })

  it('gives every lead turn, a plain telling or a remember ask, a keeping rule with no line to copy that says it was kept', async () => {
    const seen: string[] = []
    const engine = fake(async job => { seen.push([job.system, job.opening, job.prompt].join('\n')); return '좋네요.' })
    const world = await openWorld(await temp(), engine)
    for (const ask of ['우리 집 강아지가 어제 처음 동네 한 바퀴 돌았어', '내 자전거 보관함 번호 412번이야, 기억해 줘', '아 412 말고 421이었어'])
      await answer({ ...world, history: [] }, ask)
    expect(seen).toHaveLength(3)
    for (const input of seen) {
      expect(input).toContain('Keeping what they tell you is silent')
      const examples = [...input.matchAll(/"([^"]*[가-힣][^"]*)"/g)].map(found => found[1]!)
      expect(examples.length).toBeGreaterThan(5)
      expect(examples.filter(line => /기억해|기억할|저장했어|적어 둘/.test(line))).toEqual([])
    }
  })

  it('gives a lookup ask the quick model\'s own ack, like any other ask', async () => {
    const shown: string[] = []
    const engine = fake(async () => '오사카는 토요일 오후에 비가 와요.', async () => ({ text: '오사카 주말 예보부터 볼게요.', handOff: '오사카 주말 비 소식' }))
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
    const engine = fake(async () => '영수증은 달별로 나눠 뒀어요.', async () => ({ text: '영수증부터 달별로 나눌게요.', handOff: '영수증 달별 정리' }))
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
    expect(own).not.toMatch(/namedText|namedBy|fileGiven|deskLane|deskKind|deskLight|closingBuilds/)
    expect(own.indexOf('await skills()')).toBeGreaterThan(run)
    expect(ipc).toMatch(/for \(const ack of acks\) ack\.end\(\)/)
  })
})

describe('three tiers: the work lead can pass a hard job to the deep tier', () => {
  const escalate = (job: ToolSessionJob) => job.tools.find(one => one.name === 'escalate')!
  it('a hard job streams one sentence, calls escalate, and the deep tier carries on in its own session on the smart model', async () => {
    const jobs: ToolSessionJob[] = []
    const engine = fake(async job => {
      jobs.push(job)
      if (jobs.length > 1) return '사내 동호회 다섯 곳 예산을 맞춰 보니 등산회부터 줄이면 돼요.'
      job.onToken?.('다섯 동호회 예산을 서로 맞춰 봐야 해서 조금 걸려요.')
      job.onReset?.()
      await escalate(job).run({ why: '예산 다섯 개를 맞춰 계획까지 세워야 해서' }).catch(() => undefined)
      return ''
    })
    const { trace, result } = await answer(await openWorld(await temp(), engine), '사내 동호회 다섯 곳 올해 예산을 서로 비교해서 내년에 어디를 얼마씩 줄일지 단계별로 짜줘')
    expect(jobs).toHaveLength(2)
    expect(jobs[0]!.modelHint).toBeUndefined()
    expect(jobs[1]!.modelHint).toBe('smart')
    expect(jobs[1]!.sessionKey).toMatch(/:deep$/)
    expect(jobs[1]!.tools.map(one => one.name)).not.toContain('escalate')
    expect(jobs[1]!.prompt).toContain('This job was passed to you because it needs more thought: "예산 다섯 개를 맞춰 계획까지 세워야 해서"')
    expect(jobs[1]!.prompt).toContain('The person has already been shown this first line from you: "다섯 동호회 예산을 서로 맞춰 봐야 해서 조금 걸려요."')
    expect(trace.escalated).toMatchObject({ why: '예산 다섯 개를 맞춰 계획까지 세워야 해서', said: '다섯 동호회 예산을 서로 맞춰 봐야 해서 조금 걸려요.' })
    expect(trace.final.text).toBe('사내 동호회 다섯 곳 예산을 맞춰 보니 등산회부터 줄이면 돼요.')
    expect(result?.answer).toBe(trace.final.text)
  })

  it('a turn its caller already runs on the deep tier keeps the smart model and is offered no escalate', async () => {
    const jobs: ToolSessionJob[] = []
    const engine = fake(async job => { jobs.push(job); return '봉사 동아리 일정은 셋이 나눠 맡았어요.' })
    const { trace } = await answer(await openWorld(await temp(), engine), '봉사 동아리 이번 달 일정 셋이 나눠서 정리해줘', { role: 'deep' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.modelHint).toBe('smart')
    expect(jobs[0]!.tools.map(one => one.name)).not.toContain('escalate')
    expect(trace.escalated).toBeUndefined()
  })

  it('a stop during the work step never starts the deep step', async () => {
    const stop = new AbortController()
    let calls = 0
    const engine = fake(async job => {
      calls++
      job.onToken?.('창고 재고를 품목별로 다 맞춰 봐야 해서 조금 걸려요.')
      stop.abort()
      await escalate(job).run({ why: '품목이 많아서' }).catch(() => undefined)
      return ''
    })
    const { trace } = await answer(await openWorld(await temp(), engine), '창고 재고 품목별로 다 맞춰 보고 다음 달 발주 계획 세워줘', { signal: stop.signal })
    await wait(30)
    expect(calls).toBe(1)
    expect(trace.escalated).toBeUndefined()
    expect(trace.end).toBe('stop')
  })
})

describe('a correction, a file sort and a slide fix are the model\'s own tool calls; the host writes no reply', () => {
  const tool = (job: ToolSessionJob, name: string) => job.tools.find(one => one.name === name)!
  it('a correction reaches the model, whose keep_in_mind call replaces the old fact, and the thread stores the model\'s words', async () => {
    const { loadBotMemory, PERSON_MEMORY } = await import('core')
    let calls = 0
    const engine = fake(async job => {
      calls++
      if (calls === 1) { await tool(job, 'keep_in_mind').run({ facts: ['내 단골 빵집은 전주점이다'] }, {}); return '알겠어요.' }
      expect(job.prompt).toContain('군산점')
      await tool(job, 'keep_in_mind').run({ facts: ['내 단골 빵집은 군산점이다'], replaces: ['내 단골 빵집은 전주점이다'] }, {})
      return '군산점으로 고쳤어요.'
    })
    const world = await openWorld(await temp(), engine)
    await answer(world, '내 단골 빵집은 전주점이야, 잊지 말아줘')
    const { result } = await answer(world, '어 전주점 아니라 군산점이었어')
    expect(calls).toBe(2)
    expect(result?.answer).toBe('군산점으로 고쳤어요.')
    expect(result?.steps.map(step => step.tool)).toEqual(['keep_in_mind'])
    expect((await loadBotMemory(world.paths, PERSON_MEMORY)).facts.map(fact => fact.text)).toEqual(['내 단골 빵집은 군산점이다'])
    expect(world.history.filter(turn => turn.role === 'assistant').map(turn => turn.text)).toEqual(['알겠어요.', '군산점으로 고쳤어요.'])
  })

  it('a sort ask reaches the model with file_move on its menu, and the files move only by the model\'s call', async () => {
    const { mkdir, readdir } = await import('node:fs/promises')
    let menu: string[] = []
    const engine = fake(async job => {
      menu = job.tools.map(one => one.name)
      await tool(job, 'file_move').run({ moves: [{ from: '스캔본/영수증.jpg', to: '스캔본/사진/영수증.jpg' }, { from: '스캔본/계약서.pdf', to: '스캔본/문서/계약서.pdf' }] }, {})
      return '사진이랑 문서로 나눠 뒀어요.'
    })
    const world = await openWorld(await temp(), engine)
    await mkdir(join(world.paths.workspace, '스캔본'), { recursive: true })
    for (const name of ['영수증.jpg', '계약서.pdf']) await writeFile(join(world.paths.workspace, '스캔본', name), name)
    const { result } = await answer(world, '스캔본 안에 있는 거 사진 문서 나눠서 넣어놔')
    expect(menu).toContain('file_move')
    expect(result?.answer).toBe('사진이랑 문서로 나눠 뒀어요.')
    expect((await readdir(join(world.paths.workspace, '스캔본'))).sort()).toEqual(['문서', '사진'])
    expect(world.history.at(-1)).toEqual({ role: 'assistant', text: '사진이랑 문서로 나눠 뒀어요.' })
  })

  it('a slide title ask reaches the model with the document tools, and nothing is edited before it is asked', async () => {
    let asked = '', menu: string[] = []
    const engine = fake(async job => { asked = job.prompt; menu = job.tools.map(one => one.name); return '두 번째 장 제목을 "올해 목표"로 바꿨어요.' })
    const { result } = await answer(await openWorld(await temp(), engine), '아까 그 발표자료 두 번째 장 머리글 "올해 목표"로 고쳐줘')
    expect(asked).toContain('올해 목표')
    expect(menu).toEqual(expect.arrayContaining(['file_read_package', 'file_edit_package']))
    expect(result?.answer).toBe('두 번째 장 제목을 "올해 목표"로 바꿨어요.')
  })

  it('answer.ts has no reply of its own', () => {
    const own = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')
    expect(own).not.toMatch(/desk-lane|keptFix|plainKeep|slideTitleFix|fixSlideTitle|sortByKind|keepAsk|const host/)
    expect(own).toContain("return runComet({ engine, workdir: engineCwd(paths), tools: menu, ...(imagePaths ? { imagePaths } : {}) }, message, {")
  })
})
