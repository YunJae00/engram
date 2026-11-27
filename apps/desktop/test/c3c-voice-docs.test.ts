import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendBotTurn, initVault, readBotTranscript, type AgentTool, type Engine, type QuickReply, type ToolSessionJob } from 'core'

const bus = vi.hoisted(() => ({ sent: [] as { type: string; reset?: boolean; drop?: boolean; text?: string }[] }))
vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: (event: { type: string }) => { bus.sent.push(event) } }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import * as firstLine from '../src/main/first-line.js'
import { sessionRules } from '../../../packages/core/test/rules.js'
const FIRST_LINE_FUNCTIONS = ['beginFirstLine', 'cleanLine', 'endFirstLine', 'firstLineCarried', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineState', 'wantsFirstLine', 'warmFirstLine']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('afterAnswer = async () => {')).split('result.answer = ').length - 1
import { beginFirstLine, endFirstLine, FIRST_LINE_FALLBACK_MS, firstLineCarried, firstLineReady, firstLineSaw, firstLineSpoke, SAFETY_LINE, wantsFirstLine, type FirstLineAsk } from '../src/main/first-line.js'
import { firstLineNote } from './ack-prompt.js'
import { answer, openWorld } from '../src/main/answer.js'
import { conversationProgress } from '../src/main/conversation-progress.js'
import { turnGoals } from '../src/main/turn-state.js'
import { asksForCheck } from '../src/main/result-check.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { displayTaskAnswer } from '../src/renderer/src/lib/threadLang.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const COLLEAGUE_RULE = readFileSync(new URL('../../../packages/core/src/prompt.ts', import.meta.url), 'utf8')
const tool = (name: string): AgentTool => ({ name, description: name, argsSchema: { type: 'object' }, run: async () => '' })
const MENU = ['keep_in_mind', 'search_memory', 'file_read', 'find_files', 'file_move', 'ppt_build', 'file_read_package', 'file_edit_package', 'search_web', 'open_page', 'ask_person', 'report_result_check'].map(tool)
async function lead(message: string, history: { role: 'user' | 'assistant'; text: string }[] = [], quick: (prompt: string) => Promise<QuickReply> = async () => ({ text: '', handOff: message })) {
  const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-')), jobs: ToolSessionJob[] = []
  try {
    const engine = { id: 'claude', desktopToolIsolation: true, quick, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '네, 그렇게 할게요.' } } } as unknown as Engine
    const { result } = await answer({ ...await openWorld(root, engine), history: [...history] }, message, { tools: MENU })
    return { job: jobs[0], calls: jobs.length, posted: result?.answer, told: jobs.map(job => `${job.system}\n${job.opening ?? ''}\n${job.prompt}`).join('\n') }
  } finally { await rm(root, { recursive: true, force: true }) }
}
const WORKDIR = { kind: 'vault' as const, path: 'C:/vault' } as never

describe('the first line is a waiting line, not part of the answer', () => {
  const ask = (patch: Partial<FirstLineAsk> = {}): FirstLineAsk => ({ channel: 'bot-1', message: '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', korean: true, interactive: true, studying: false, limited: false, secret: false, ...patch })
  const later = (reply: QuickReply, ms: number) => () => new Promise<QuickReply>(done => setTimeout(() => done(reply), ms))
  const start = (line: string, patch: Partial<FirstLineAsk> = {}, ms = 500, whole = false) => {
    const show = vi.fn(), hide = vi.fn(), quick = vi.fn(() => later(whole ? { text: line } : { text: line, handOff: 'the job' }, ms)())
    const decided = beginFirstLine({ ...ask(patch), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, hide })
    firstLineReady('bot-1')
    return { show, hide, quick, decided }
  }
  beforeEach(() => { vi.useFakeTimers(); endFirstLine('bot-1'); bus.sent.length = 0 })
  afterEach(() => { endFirstLine('bot-1'); vi.useRealTimers() })

  it('a voice too slow for the safety line and no tool call: the safety line is taken down when the answer is shown, once', async () => {
    const { show, hide } = start('', {}, 3000)
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
    firstLineSpoke('bot-1')
    expect(hide).toHaveBeenCalledOnce()
    expect(firstLineCarried('bot-1')).toBeUndefined()
    firstLineSpoke('bot-1')
    expect(hide).toHaveBeenCalledOnce()
    expect(source('ipc.ts')).toContain('extractChatCaptures(finishProgress(channel, rawText))')
    expect(source('first-line.ts')).not.toContain('export function withFirstLine')
  })

  it('stack-3: a lookup gets the voice\'s line and keeps it after a reset, and no round of the hold is aloud', async () => {
    const { show, hide, quick } = start('지금 시세 확인할게요.', { message: '엔비디아 오늘 주가 알려줘' })
    await vi.advanceTimersByTimeAsync(500)
    expect(show).toHaveBeenCalledExactlyOnceWith('지금 시세 확인할게요.')
    expect(quick).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).toHaveBeenCalledOnce()
    firstLineSaw({ type: 'chat:token', channel: 'bot-1', reset: true })
    firstLineSpoke('bot-1')
    expect(hide).not.toHaveBeenCalled()
    const ipc = source('ipc.ts')
    expect(ipc).toContain('ack: { channel,')
    expect(source('answer.ts')).toMatch(/if \(!hold\) \{\n\s*firstLineSpoke\(channel\)/)
    expect(ipc).toContain("if (!held && !signal.aborted && !turn?.verification) broadcast({ type: 'chat:token', channel, text })")
    expect(ipc).not.toContain('replying')
    const aside = source('aside-ipc.ts')
    expect(aside).not.toMatch(/asideVoice|heldRounds|quick\(/)
  })

  it('the safety line and a tool call: it stays as the acknowledgement bubble, like a line the voice wrote', async () => {
    const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-')), paths = await initVault(root, { git: false })
    try {
      const progress = conversationProgress(paths), channel = 'bot-1'
      turnGoals.set(channel, '우리 강아지 이름은 콩떡이야. 기억해')
      await appendBotTurn(paths, '1', { role: 'user', text: '우리 강아지 이름은 콩떡이야. 기억해', at: 'start' })
      const { show } = start('', { message: '우리 강아지 이름은 콩떡이야. 기억해' }, 3000)
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
      progress.observe({ type: 'chat:token', channel, text: `${SAFETY_LINE.ko}\n\n` })
      progress.observe({ type: 'comet:step', channel, line: 'keep_in_mind: 콩떡' } as never)
      expect(bus.sent.filter(event => event.type === 'chat:token' && event.reset && !event.drop)).toHaveLength(1)
      progress.observe({ type: 'chat:token', channel, text: '', reset: true })
      vi.useRealTimers()
      await vi.waitFor(async () => expect((await readBotTranscript(paths, '1')).at(-1)).toMatchObject({ role: 'assistant', text: `${SAFETY_LINE.ko}\n\n`, progress: true }))
      expect(source('ipc.ts')).toContain('onReset: (drop, tool) => { broadcast(')
    } finally { turnGoals.delete('bot-1'); await rm(root, { recursive: true, force: true }) }
  })

  it('a line that names a step stays as the acknowledgement bubble when a tool call follows it', async () => {
    const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-')), paths = await initVault(root, { git: false })
    try {
      const progress = conversationProgress(paths), channel = 'bot-1'
      turnGoals.set(channel, 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘')
      await appendBotTurn(paths, '1', { role: 'user', text: 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘', at: 'start' })
      const { show, hide } = start('회의록부터 읽어볼게요.', { message: 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘' })
      await vi.advanceTimersByTimeAsync(500)
      expect(show).toHaveBeenCalledExactlyOnceWith('회의록부터 읽어볼게요.')
      progress.observe({ type: 'chat:token', channel, text: '회의록부터 읽어볼게요.\n\n' })
      progress.observe({ type: 'comet:step', channel, line: 'Read: meeting-notes.md' } as never)
      expect(bus.sent.filter(event => event.type === 'chat:token' && event.reset && !event.drop)).toHaveLength(1)
      firstLineSaw({ type: 'chat:token', channel, reset: true })
      progress.observe({ type: 'chat:token', channel, text: '', reset: true })
      firstLineSpoke('bot-1')
      expect(hide).not.toHaveBeenCalled()
      vi.useRealTimers()
      await vi.waitFor(async () => expect((await readBotTranscript(paths, '1')).at(-1)).toMatchObject({ role: 'assistant', text: '회의록부터 읽어볼게요.\n\n', progress: true }))
    } finally { turnGoals.delete('bot-1'); await rm(root, { recursive: true, force: true }) }
  })

  it('a step line gives way too when the answer comes with no tool call', async () => {
    const { hide } = start('회의록부터 읽어볼게요.')
    await vi.advanceTimersByTimeAsync(500)
    expect(firstLineCarried('bot-1')).toBe('회의록부터 읽어볼게요.')
    firstLineSpoke('bot-1')
    expect(hide).toHaveBeenCalledOnce()
  })

  it('a short ask answered with no tool call leaves no line above the answer, still shows a waiting line at 1.5 s, and a turn with a tool keeps its line', async () => {
    const { show, hide } = start('', {}, 3000)
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
    const store = createCometThreads()
    store.begin('1', ask().message)
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: `${SAFETY_LINE.ko}\n\n` })
    const answer = '이렇게 쓰면 돼요. I apologize for being late to the meeting.'
    store.handleEvent({ type: 'chat:done', channel: 'bot-1', text: answer })
    expect(store.thread('1').messages.map(message => message.text)).toEqual([ask().message, answer])
    expect(hide).not.toHaveBeenCalled()
    expect(functionsOf(firstLine)).toEqual(FIRST_LINE_FUNCTIONS)
    expect(answerSetInTurn(source('ipc.ts'))).toBe(0)
    expect(source('ipc.ts')).toContain('result.asked ? askText(result.answer, result.options) : result.answer,')
    const rules = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, tools: [] })
    expect(rules).toContain('The answer is the first line: no preface, steps or notes to yourself.')
    expect(rules).toContain('not between paragraphs and not before a list or a table')
    expect(rules).toContain('text asked for in another language, kept as is after a few warm Korean words')
    expect(source('engine-claude-session.ts')).toContain('if (text && this.turn) this.turn.answer = text')
    expect(source('codex-native.ts')).toContain("if (type === 'agentMessage') turn.answer = text(item['text']) || turn.answer")
    expect(source('ipc.ts')).not.toContain('withoutWorkNote')
    expect(rules).toContain('is written again in it, every fact and constraint kept')
  })

  it('the renderer replaces the waiting line with the answer and keeps no trace of it', () => {
    const store = createCometThreads()
    store.begin('1', '나 누구랑 일하지?')
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '바로 확인해 볼게요.\n\n' })
    expect(store.thread('1').messages.at(-1)?.text).toBe('바로 확인해 볼게요.\n\n')
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '', reset: true, drop: true })
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '민호 님이랑 ' })
    expect(store.thread('1').messages.at(-1)?.text).toBe('민호 님이랑 ')
    store.handleEvent({ type: 'chat:done', channel: 'bot-1', text: '민호 님이랑 일하세요.' })
    expect(store.thread('1').messages.map(message => message.text)).toEqual(['나 누구랑 일하지?', '민호 님이랑 일하세요.'])
  })

  it('tells the model that its next words are the answer, whichever line is up', async () => {
    start('', {}, 3000)
    expect(firstLineNote('bot-1')).toContain('Write nothing before your first tool call and nothing between tool calls')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(firstLineNote('bot-1')).not.toContain(SAFETY_LINE.ko)
    expect(firstLineNote('bot-1')).toContain('Your next words to the person are the answer itself.')
  })

  it('the host has one safety line for every ask, and leaves naming the step to the voice', async () => {
    for (const message of ['내 이름은 권윤재고 지민호랑 같이 일해. 기억해', '아 그거 말고 11월 걸로', '방금 말한 거 더 짧게', '정리한 폴더에 PDF 몇 개야?', '이걸로 해', 'ㅁㄴㅇㄹ']) {
      endFirstLine('bot-1')
      const slow = start('', { message }, 3000)
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(slow.show, message).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
      endFirstLine('bot-1')
      const named = start('메모장부터 열어 볼게요.', { message })
      await vi.advanceTimersByTimeAsync(500)
      expect(named.show, message).toHaveBeenCalledExactlyOnceWith('메모장부터 열어 볼게요.')
    }
  })

  it('takes thanks, praise and goodbyes to the one quick call like any message, and the whole reply it writes is the answer: no line, no note and no safety line', async () => {
    for (const message of ['오늘 정말 애쓰셨어요', '덕분에 발표 잘 끝났어요', '내일 봬요!', '역시 믿고 맡길 만하네요']) {
      expect(wantsFirstLine({ channel: 'bot-1', message, korean: true, interactive: true, studying: false, limited: false, secret: false }), message).toBeNull()
      endFirstLine('bot-1')
      const { show, quick, decided } = start('별말씀을요.', { message }, 500, true)
      await vi.advanceTimersByTimeAsync(500)
      expect(quick, message).toHaveBeenCalledOnce()
      expect(await decided, message).toEqual({ answer: '별말씀을요.' })
      expect(firstLineNote('bot-1')).toBe('')
      await vi.advanceTimersByTimeAsync(3000)
      expect(show, message).not.toHaveBeenCalled()
    }
  })

  it('takes something the person only told to the quick tier, which reads that one message and nothing said before it, and posts its whole reply as written with no lead step', async () => {
    vi.useRealTimers()
    const said = '이번 토요일에 동생 결혼식이라 아침 일찍 대전 내려가'
    const asked: string[] = []
    const { calls, posted } = await lead(said, [{ role: 'user', text: '주말에 뭐 할지 아직 몰라' }, { role: 'assistant', text: '천천히 정하셔도 돼요.' }], async prompt => { asked.push(prompt); return { text: '축하드려요, 조심히 다녀오세요.' } })
    expect(calls).toBe(0)
    expect(posted).toBe('축하드려요, 조심히 다녀오세요.')
    expect(asked).toHaveLength(1)
    expect(asked[0]).not.toContain('주말에 뭐 할지 아직 몰라')
    expect(asked[0]).toContain(said)
    expect(source('answer.ts')).not.toMatch(/told:|onlyTells|TOLD_NOTE/)
    expect(source('ipc.ts')).not.toMatch(/reply: !\(turn\?\.context/)
    expect(source('answer.ts')).not.toMatch(/talked|smallTalkAnswer/)
    expect(source('answer.ts')).toContain("if (decided && 'answer' in decided) result = { answer: decided.answer, steps: [], fellBack: false }")
  })
})

describe('nothing is said before or between tool calls once the host has spoken', () => {
  const streamed = async (pieces: string[], options: { ack?: string } = {}): Promise<{ text: string; held: boolean }[]> => {
    const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-'))
    try {
      const engine = { id: options.ack === undefined ? 'mock' : 'claude', desktopToolIsolation: true, quick: async () => ({ text: options.ack ?? '', handOff: 'the job' }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: { onToken?(text: string): void }) => { await new Promise(done => setTimeout(done, 20)); for (const piece of pieces) job.onToken?.(piece); return { answer: pieces.at(-1)! } } } as unknown as Engine
      const seen: { text: string; held: boolean }[] = []
      await answer(await openWorld(root, engine), '분기 실적 슬라이드 정리해줘', { onToken: (text, held) => { seen.push({ text, held }) } })
      return seen
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  it('holds the lead\'s words while its first line is still on its way, and streams them as written once a line is up', async () => {
    for (const narration of ['I\'ll read the file first.', 'I\'ll read the sales data and build the monthly summary workbook with a chart.', '3번 슬라이드 제목이 "지역별 실적"으로 되어 있네요. 그 부분만 바꿔요.']) {
      for (const ack of ['실적 표부터 볼게요.', '슬라이드 순서부터 훑어볼게요.']) {
        const seen = await streamed([narration, '3번 슬라이드 제목을 "핵심 지표"로 바꿨어요.'], { ack })
        expect(seen.map(one => one.held), narration).toEqual([false, false])
      }
      expect((await streamed([narration, '3번 슬라이드 제목을 "핵심 지표"로 바꿨어요.'], { ack: '' })).map(one => one.held), narration).toEqual([true, true])
    }
    expect(source('answer.ts')).toContain("const now = firstLineState(channel), hold = !!now && 'pending' in now")
  })

  it('holds a long round of words of any language while no line is up yet, and shows a plain answer with no line on its way as it comes', async () => {
    for (const narration of ['I will read the sales data first, then build the monthly summary workbook with a chart, and after that I will double-check every total against the source rows before writing the final answer. '.repeat(2), '먼저 파일을 읽고, 그다음 표를 만들고, 마지막으로 합계를 하나씩 맞춰 본 다음에 정리해서 올릴게요. '.repeat(6)]) {
      expect([...narration].length).toBeGreaterThan(200)
      const seen = await streamed(narration.match(/.{1,40}/g)!, { ack: '' })
      expect(seen.every(one => one.held), narration.slice(0, 30)).toBe(true)
    }
    expect((await streamed(['지금 1달러에 1,385원이에요.'])).map(one => one.held)).toEqual([false])
  })

  it('shows and stores every interim line as the model wrote it, with no language check by the host; the Korean rule is in the prompt', async () => {
    const store = createCometThreads()
    store.begin('1', 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘')
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: 'I\'ll read the file first.' })
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '', reset: true })
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '결정사항이랑 할 일 위주로 정리했어요.' })
    store.handleEvent({ type: 'chat:done', channel: 'bot-1', text: '결정사항이랑 할 일 위주로 정리했어요.' })
    expect(store.thread('1').messages.map(message => message.text)).toEqual(['fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', 'I\'ll read the file first.', '결정사항이랑 할 일 위주로 정리했어요.'])
    expect(sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, tools: [] })).toContain('In a Korean thread all is Korean')
    store.begin('2', '도시 네 곳 날씨 정리해줘')
    store.handleEvent({ type: 'chat:token', channel: 'bot-2', text: '셋 중 둘은 끝났어요.' })
    store.handleEvent({ type: 'chat:token', channel: 'bot-2', text: '', reset: true })
    expect(store.thread('2').messages.find(message => message.progress)?.text).toBe('셋 중 둘은 끝났어요.')
    store.begin('3', 'Read all four items')
    store.handleEvent({ type: 'chat:token', channel: 'bot-3', text: 'Two of four are done.' })
    store.handleEvent({ type: 'chat:token', channel: 'bot-3', text: '', reset: true })
    expect(store.thread('3').messages.find(message => message.progress)?.text).toBe('Two of four are done.')

    const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-')), paths = await initVault(root, { git: false })
    try {
      const progress = conversationProgress(paths)
      turnGoals.set('bot-9', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘')
      await appendBotTurn(paths, '9', { role: 'user', text: 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', at: 'start' })
      progress.observe({ type: 'chat:token', channel: 'bot-9', text: 'I\'ll read the sales data and build the monthly summary workbook with a chart.' })
      await progress.flush('bot-9')
      progress.observe({ type: 'chat:token', channel: 'bot-9', text: '월별 합계는 다 넣었어요.' })
      await progress.flush('bot-9')
      expect((await readBotTranscript(paths, '9')).filter(turn => turn.progress).map(turn => turn.text)).toEqual(['I\'ll read the sales data and build the monthly summary workbook with a chart.', '월별 합계는 다 넣었어요.'])
    } finally { turnGoals.delete('bot-9'); await rm(root, { recursive: true, force: true }) }
  })
})

describe('short asks, statements and corrections', () => {
  it('gives a short ask to write, reword, pick or translate the same menu and call shape as a file or deck ask: no short rules, no model hint, no light effort', async () => {
    const asks = ['송년회 초대 문구 한 줄 지어줘', '이 메모 더 다정하게 바꿔줘', '야유회 장소 두 곳만 추천해줘', '사내 봉사활동 소개 슬라이드 4장 만들어줘', '창고 재고 파일 열어서 볼펜 몇 개 남았는지 알려줘']
    const jobs = await Promise.all(asks.map(async ask => (await lead(ask)).job!))
    for (const [at, job] of jobs.entries()) {
      expect(job.tools.map(one => one.name), asks[at]).toEqual(jobs[0]!.tools.map(one => one.name))
      expect(job.tools.map(one => one.name), asks[at]).toEqual(expect.arrayContaining(MENU.map(one => one.name)))
      expect(job.system, asks[at]).toBe(jobs[0]!.system)
      expect(job.modelHint, asks[at]).toBeUndefined()
      expect(job.effort, asks[at]).toBeUndefined()
    }
  })

  it('takes a correction to the lead as typed, with the ask before it in the history and no host note on what is asked now', async () => {
    const earlier = [{ role: 'user' as const, text: '본관 식당 이번 주 메뉴 정리해줘' }, { role: 'assistant' as const, text: '본관 식당 메뉴를 요일별로 정리했어요.' }]
    const { job, told } = await lead('아니 그거 말고 별관 식당 걸로', earlier)
    expect(job!.prompt).toContain('아니 그거 말고 별관 식당 걸로')
    expect(told).toContain('본관 식당 이번 주 메뉴 정리해줘')
    expect(told).not.toContain('What the person asks for now')
    expect(told).not.toContain('The person then changed it')
    expect(source('answer.ts')).not.toMatch(/routeAsk|askNow|isCorrection/)
  })
})

describe('desk tool menus', () => {
  it('keeps the check tool on the one menu, so a check the person asked for can run on any turn', async () => {
    for (const message of ['3분기 실적 PPT 5장 만들고 숫자 맞는지 확인까지 해줘', 'Build the Q3 deck and double-check the numbers', 'fixtures/inbox-dump 폴더 파일들 종류별로 정리하고 빠진 거 없는지 검증까지 해줘', 'fixtures/meeting-notes.md 요약하고 한 번 더 확인해줘']) expect(asksForCheck(message), message).toBe(true)
    expect(asksForCheck('다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적')).toBe(false)
    expect((await lead('사내 봉사활동 소개 슬라이드 4장 만들고 숫자 맞는지 확인까지 해줘')).job!.tools.map(one => one.name)).toContain('report_result_check')
    expect(source('ipc.ts')).toContain("...(!turn?.verification && !asksForCheck(turnGoals.get(channel) ?? '') ? [] : [resultCheckTool(")
  })

  it('gives a remember, tidy, note, short-ask and deck turn the whole menu the caller passed, with no kind table in between', async () => {
    for (const message of ['우리 팀 회식은 매달 셋째 주 목요일이야', '공유 폴더 사진들 날짜별로 나눠줘', 'fixtures/weekly-sync.md 메모에서 결정된 것만 추려줘', '송년회 초대 문구 한 줄 지어줘', '사내 봉사활동 소개 슬라이드 4장 만들어줘']) {
      expect((await lead(message)).job!.tools.map(one => one.name), message).toEqual(expect.arrayContaining(MENU.map(one => one.name)))
    }
    const answerSource = source('answer.ts')
    expect(answerSource).toContain('[...everyTool, escalate]')
    expect(answerSource).not.toMatch(/DESK_TOOLS|deskMenu|closingBuilds/)
  })

  it('ends a tidy-up with counts per kind and answers a note in the chat', () => {
    expect(COLLEAGUE_RULE).toContain('sorted files are counts per kind')
    expect(COLLEAGUE_RULE.match(/exactly one short offer line/g)).toHaveLength(1)
    expect(COLLEAGUE_RULE).toContain('The answer is the first line: no preface')
    expect(COLLEAGUE_RULE).toContain('A summary or tidy-up of a short note is answered in the chat')
    expect(COLLEAGUE_RULE).toContain('holds only what is in it')
  })
})

describe('a delivered answer is shown alone', () => {
  const reason = 'Unverified collection items (2/6): 한라산: The cited observation does not establish this item\'s limitation.'
  const wrapped = `Not verified as complete.\n\n${reason}\n\nUnverified response:\n덜 걷는 곳으로 세 군데 골랐어요.\n\n1. 해안도로 드라이브`

  it('posts the model\'s words with no reason wrapped around them, and an old wrapped turn still shows only its answer', () => {
    expect(displayTaskAnswer(wrapped, 'ko')).toBe('덜 걷는 곳으로 세 군데 골랐어요.\n\n1. 해안도로 드라이브')
    expect(displayTaskAnswer(wrapped, 'ko')).not.toMatch(/Unverified|확인하지 못한|현재까지/)
    const empty = 'Not verified as complete.\n\nThe last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
    expect(displayTaskAnswer(empty, 'ko')).not.toMatch(/[A-Za-z]{4,}/)
    for (const file of ['ipc.ts', 'team-runner.ts', 'result-check.ts']) expect(source(file)).not.toMatch(/answerOnly|Not verified as complete/)
  })

  it('offers the check tool only when the person asked for a check, or on a check turn', () => {
    for (const message of ['PPT 만들고 숫자 맞는지 확인까지 해줘', '보고서 쓰고 검증도 해줘', '다 만든 다음에 한 번 더 확인해줘', '오타 없는지 제대로 검토해줘', 'Build the deck and double-check the numbers', 'Make the workbook, then verify it']) expect(asksForCheck(message), message).toBe(true)
    for (const message of ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', '오늘 서울 날씨 확인해줘', '내 일정 확인해줘', 'Check the weather in Seoul']) expect(asksForCheck(message), message).toBe(false)
    expect(source('ipc.ts')).toContain("...(!turn?.verification && !asksForCheck(turnGoals.get(channel) ?? '') ? [] : [resultCheckTool(turn?.verification ? {")
  })
})
