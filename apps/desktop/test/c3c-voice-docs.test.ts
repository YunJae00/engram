import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendBotTurn, initVault, readBotTranscript, sessionRules } from 'core'

const bus = vi.hoisted(() => ({ sent: [] as { type: string; reset?: boolean; drop?: boolean; text?: string }[] }))
vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: (event: { type: string }) => { bus.sent.push(event) } }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import * as firstLine from '../src/main/first-line.js'
const FIRST_LINE_FUNCTIONS = ['beginFirstLine', 'cleanLine', 'endFirstLine', 'fallbackLine', 'firstLineCarried', 'firstLineNote', 'firstLineNow', 'firstLinePrompt', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineWaiting', 'greeting', 'heldRounds', 'laneLine', 'plainReply', 'quickAnswerPrompt', 'saidBefore', 'smallTalkAnswer', 'smallTalkPrompt', 'splitAsk', 'toldPrompt', 'wantsFirstLine', 'warmFirstLine']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await lookup.run('), ipc.indexOf('answerDelivered = true')).split('result.answer = ').length - 1
import { beginFirstLine, endFirstLine, fallbackLine, firstLineCarried, firstLineNote, firstLineReady, firstLineSaw, firstLineSpoke, firstLineWaiting, greeting, heldRounds, plainReply, smallTalkAnswer, toldPrompt, wantsFirstLine, type FirstLineAsk } from '../src/main/first-line.js'
import { conversationProgress } from '../src/main/conversation-progress.js'
import { turnGoals } from '../src/main/turn-state.js'
import { DESK_NOTE, DESK_TOOLS, deskKind, deskLane, isCorrection, routeAsk, onlyTells, TOLD_NOTE } from '../src/main/desk-lane.js'
import { fastLane, quietRounds, SHORT_QUESTION_NOTE, shortAsk, shortQuestion } from '../src/main/fast-lane.js'
import { PRELOADED_TOOLS_MAX } from '../src/main/engine-claude-session.js'
import { answerOnly, asksForCheck } from '../src/main/result-check.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { displayTaskAnswer } from '../src/renderer/src/lib/threadLang.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const WORKDIR = { kind: 'vault' as const, path: 'C:/vault' } as never

describe('the first line is a waiting line, not part of the answer', () => {
  const ask = (patch: Partial<FirstLineAsk> = {}): FirstLineAsk => ({ channel: 'bot-1', message: '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, ...patch })
  const later = (text: string, ms: number) => () => new Promise<string>(done => setTimeout(() => done(text), ms))
  const start = (reply: string | ((prompt: string) => string), patch: Partial<FirstLineAsk> = {}, more: { told?: boolean; context?: () => Promise<string> } = {}) => {
    const show = vi.fn(), hide = vi.fn(), quick = vi.fn((prompt: string) => later(typeof reply === 'string' ? reply : reply(prompt), 500)()), message = ask(patch).message
    beginFirstLine({ ...ask(patch), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, hide, fallback: fallbackLine(message, true), ...more })
    firstLineReady('bot-1')
    return { show, hide, quick }
  }
  beforeEach(() => { vi.useFakeTimers(); endFirstLine('bot-1'); bus.sent.length = 0 })
  afterEach(() => { endFirstLine('bot-1'); vi.useRealTimers() })

  it('a voice with no line and no tool call: the waiting line is taken down when the answer is shown, once', async () => {
    const { show, hide } = start('')
    await vi.advanceTimersByTimeAsync(500)
    expect(show).toHaveBeenCalledExactlyOnceWith('바로 써 볼게요.')
    expect(firstLineWaiting('bot-1')).toBe(true)
    firstLineSpoke('bot-1')
    expect(hide).toHaveBeenCalledOnce()
    expect(firstLineWaiting('bot-1')).toBe(false)
    expect(firstLineCarried('bot-1')).toBeUndefined()
    firstLineSpoke('bot-1')
    expect(hide).toHaveBeenCalledOnce()
    expect(source('ipc.ts')).toContain('extractChatCaptures(finishProgress(channel, rawText))')
    expect(source('first-line.ts')).not.toContain('export function withFirstLine')
  })

  it('stack-3: a host-answered ask shows no line, a lookup shows its own line at once and keeps it, and no round of either hold is aloud', async () => {
    const hosted = start('NONE', { message: '지우가 누구야?', host: true }, { told: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(hosted.show).not.toHaveBeenCalled()
    expect(hosted.quick).not.toHaveBeenCalled()
    expect(firstLineWaiting('bot-1')).toBe(false)
    endFirstLine('bot-1')
    const show = vi.fn(), hide = vi.fn(), quick = vi.fn(later('NONE', 500))
    beginFirstLine({ ...ask({ message: '엔비디아 오늘 주가 알려줘' }), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, hide, line: '지금 시세 확인할게요.', fallback: '바로 확인해 볼게요.' })
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(show).toHaveBeenCalledExactlyOnceWith('지금 시세 확인할게요.')
    expect(quick).not.toHaveBeenCalled()
    expect(firstLineWaiting('bot-1')).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).toHaveBeenCalledOnce()
    firstLineSaw({ type: 'chat:token', channel: 'bot-1', reset: true })
    firstLineSpoke('bot-1')
    expect(hide).not.toHaveBeenCalled()
    const ipc = source('ipc.ts')
    expect(ipc).toContain('beginFirstLine({ host: hostAnswers, channel: entry.channel,')
    expect(ipc).toContain('onToken: (text) => { if (!quiet) firstLineSpoke(channel);')
    expect(ipc).toContain("if (quiet) quiet.token(text, false); else broadcast({ type: 'chat:token', channel, text })")
    expect(ipc).not.toContain('replying')
    const aside = source('aside-ipc.ts')
    expect(aside).toContain('asideVoice(')
    expect(aside).not.toContain('heldRounds')
  })

  it('a voice with no line and a tool call: the waiting line is not frozen into a bubble, in the thread or on disk', async () => {
    const root = await mkdtemp(join(process.cwd(), 'tmp/c3c-')), paths = await initVault(root, { git: false })
    try {
      const progress = conversationProgress(paths), channel = 'bot-1'
      turnGoals.set(channel, '우리 강아지 이름은 콩떡이야. 기억해')
      await appendBotTurn(paths, '1', { role: 'user', text: '우리 강아지 이름은 콩떡이야. 기억해', at: 'start' })
      start('', { message: '우리 강아지 이름은 콩떡이야. 기억해' })
      await vi.advanceTimersByTimeAsync(500)
      progress.observe({ type: 'chat:token', channel, text: '바로 적어 둘게요.\n\n' })
      progress.observe({ type: 'comet:step', channel, line: 'keep_in_mind: 지민호' } as never)
      expect(bus.sent.filter(event => event.type === 'chat:token' && event.reset)).toEqual([])
      progress.observe({ type: 'chat:done', channel, text: '기억해 둘게요.' })
      await progress.flush(channel)
      vi.useRealTimers()
      expect((await readBotTranscript(paths, '1')).map(turn => turn.text)).toEqual(['우리 강아지 이름은 콩떡이야. 기억해'])
      expect(source('ipc.ts')).toContain('onReset: (drop, tool) => { if (firstLineWaiting(channel)) return; broadcast(')
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
      expect(firstLineWaiting('bot-1')).toBe(false)
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

  it('a short ask answered with no tool call leaves no line above the answer, still shows a waiting line at once, and a turn with a tool keeps its line', async () => {
    const { show, hide } = start('')
    await vi.advanceTimersByTimeAsync(500)
    expect(show).toHaveBeenCalledExactlyOnceWith('바로 써 볼게요.')
    const store = createCometThreads()
    store.begin('1', ask().message)
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '바로 써 볼게요.\n\n' })
    const answer = '이렇게 쓰면 돼요. I apologize for being late to the meeting.'
    store.handleEvent({ type: 'chat:done', channel: 'bot-1', text: answer })
    expect(store.thread('1').messages.map(message => message.text)).toEqual([ask().message, answer])
    expect(hide).not.toHaveBeenCalled()
    expect(functionsOf(firstLine)).toEqual(FIRST_LINE_FUNCTIONS)
    expect(answerSetInTurn(source('ipc.ts'))).toBe(1)
    expect(source('ipc.ts')).toContain('`${result.asked ? askText(result.answer, result.options) : result.answer}${note}`,')
    const rules = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, kind: 'short', tools: [] })
    expect(rules).toContain('The answer is the first line: no opening line about what you are about to do, no account of your steps and no notes to yourself.')
    expect(rules).toContain('not between paragraphs and not before a list or a table')
    expect(SHORT_QUESTION_NOTE).toContain('so the reply is never the foreign line alone')
    expect(source('engine-claude-session.ts')).toContain('if (text && this.turn) this.turn.answer = text')
    expect(source('codex-native.ts')).toContain("if (type === 'agentMessage') turn.answer = text(item['text']) || turn.answer")
    expect(source('ipc.ts')).not.toContain('withoutWorkNote')
    expect(SHORT_QUESTION_NOTE).toContain('what the earlier line means and its register stay')
    expect(SHORT_QUESTION_NOTE).toContain('"I apologize for being late."')
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
    start('')
    expect(firstLineNote('bot-1')).toContain('Write nothing before your first tool call and nothing between tool calls')
    await vi.advanceTimersByTimeAsync(500)
    expect(firstLineNote('bot-1')).toContain('"바로 써 볼게요."')
    expect(firstLineNote('bot-1')).toContain('Your next words to the person are the answer itself.')
  })

  it('names a concrete first step in the host line for every bar ask, and for an ask with no known verb', async () => {
    const lines: [string, string][] = [
      ['내 이름은 권윤재고 지민호랑 같이 일해. 기억해', '바로 적어 둘게요.'],
      ['아 지민호 말고 민호야', '바로 바꿀게요.'],
      ['아 그거 말고 11월 걸로', '바로 바꿀게요.'],
      ['"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', '바로 써 볼게요.'],
      ['방금 말한 거 더 짧게', '바로 줄여 볼게요.'],
      ['나 누구랑 일하지?', '바로 확인해 볼게요.'],
      ['정리한 폴더에 PDF 몇 개야?', '파일부터 확인할게요.'],
      ['아 그 여행 가서 할 만한 거 세 개만 추천해줘', '바로 골라 볼게요.'],
      ['이거 왜 기억 못해?', '바로 확인해 볼게요.'],
      ['이걸로 해', '말씀하신 내용부터 읽어 볼게요.'],
    ]
    for (const [message, line] of lines) expect(fallbackLine(message, true), message).toBe(line)
    for (const message of [...lines.map(([message]) => message), '', 'ㅁㄴㅇㄹ', 'do the thing']) {
      expect(fallbackLine(message, true), message).not.toMatch(/처리|알겠|[A-Za-z]/)
      expect([...fallbackLine(message, true)].length).toBeLessThanOrEqual(60)
      expect(fallbackLine(message, false), message).not.toMatch(/^On it|[가-힣]/)
    }
    const { show } = start('', { message: '우리 강아지 이름은 콩떡이야. 기억해' })
    await vi.advanceTimersByTimeAsync(500)
    expect(show).toHaveBeenCalledExactlyOnceWith('바로 적어 둘게요.')
  })

  it('takes thanks, praise and goodbyes as small talk, and never a job that opens with them', () => {
    for (const message of ['고마워 수고했어', '수고했어요!', '고생했어', '고생 많았어요', '잘했어', '최고야', '고마워요 정말 최고예요', '수고 많았어요', '멋져요', '대박', '고마워 덕분에 잘 됐어', 'thanks!', '감사합니다 수고하셨어요']) {
      expect(plainReply(message), message).toBe(true)
      expect(greeting(message), message).toBe(true)
      expect(wantsFirstLine({ channel: 'bot-1', message, korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false }), message).toBe('chit-chat')
    }
    for (const message of ['고마워 이제 보고서 정리해줘', '수고했어 다음은 메일 써줘', '최고 매출 알려줘', '잘했어 근데 3번 바꿔줘', '고생했어 그리고 서연한테도 맡겨', '메일 써줘']) expect(plainReply(message), message).toBe(false)
    expect(greeting('네 좋아')).toBe(false)
  })

  it('answers something the person only told with one line from the quick voice, with the conversation in view, unless its own first line names a step', async () => {
    const said = '다음 주 목요일에 부모님 모시고 제주도 가. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어'
    const told = (reply: string, line: string) => (prompt: string) => prompt.includes('it asks for nothing') ? reply : line
    const { show, quick } = start(told('부모님이랑 제주 가시는군요, 좋으시겠어요.', 'NONE'), { message: said }, { told: true, context: async () => 'Person: 안녕\nYou: 안녕하세요!' })
    const reply = smallTalkAnswer('bot-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(await reply).toBe('부모님이랑 제주 가시는군요, 좋으시겠어요.')
    expect(show).not.toHaveBeenCalled()
    const toldCall = quick.mock.calls.map(call => String((call as unknown[])[0])).find(prompt => prompt.includes('it asks for nothing'))
    expect(toldCall).toContain('Conversation so far:\nPerson: 안녕')
    endFirstLine('bot-1')
    const declined = start('NONE', { message: said }, { told: true })
    const none = smallTalkAnswer('bot-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await none).toBeUndefined()
    expect(declined.show).toHaveBeenCalledExactlyOnceWith(fallbackLine(said, true))
    endFirstLine('bot-1')
    const work = start(told('사진 많이 찍으셨겠네요.', '사진 날짜부터 맞춰 볼게요.'), { message: '지난 주말 캠핑 사진 날짜별로 묶어서 앨범 세 개' }, { told: true })
    const dropped = smallTalkAnswer('bot-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(await dropped).toBeUndefined()
    expect(work.show).toHaveBeenCalledExactlyOnceWith('사진 날짜부터 맞춰 볼게요.')
    expect(toldPrompt(said, true)).toContain('reply with exactly NONE')
    expect(toldPrompt(said, true)).toContain('do not say you saved or noted anything')
    const ipc = source('ipc.ts')
    expect(ipc).toContain('told: onlyTells(request.message,')
    expect(ipc).toContain('if (greeted) { turnOutcomes.set(channel, { answer: greeted, asked: false, unfinished: false, steps: 0 }); await deliverAnswer(greeted); return }')
  })
})

describe('nothing is said before or between tool calls once the host has spoken', () => {
  it('holds a round that ends in a tool call on any turn with a first line, not only on a lookup', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const quiet = lane ? quietRounds(shown) : firstSaid ? heldRounds(shown) : undefined')
    for (const narration of ['I\'ll read the file first.', 'I\'ll read the sales data and build the monthly summary workbook with a chart.', '3번 슬라이드 제목이 "지역별 실적"으로 되어 있네요. 그 부분만 바꿔요.']) {
      const shown: string[] = [], quiet = quietRounds(text => shown.push(text))
      quiet.token(narration, false)
      quiet.token('3번 슬라이드 제목을 "핵심 지표"로 바꿨어요.', false)
      expect(shown, narration).toEqual([])
    }
  })

  it('shows no round of a general turn as it comes, however long, and still shows a reply to words said mid-turn', () => {
    for (const narration of ['I will read the sales data first, then build the monthly summary workbook with a chart, and after that I will double-check every total against the source rows before writing the final answer. '.repeat(2), '먼저 파일을 읽고, 그다음 표를 만들고, 마지막으로 합계를 하나씩 맞춰 본 다음에 정리해서 올릴게요. '.repeat(6)]) {
      expect([...narration].length).toBeGreaterThan(200)
      const shown: string[] = [], held = heldRounds(text => shown.push(text))
      for (const piece of narration.match(/.{1,40}/g)!) held.token(piece, false)
      held.reset()
      expect(shown, narration.slice(0, 30)).toEqual([])
      const leaked: string[] = [], lookup = quietRounds(text => leaked.push(text))
      lookup.token(narration, false)
      expect(leaked).toEqual([])
    }
    const shown: string[] = [], held = heldRounds(text => shown.push(text))
    held.token('대구도 넣을게요.', true)
    expect(shown).toEqual(['대구도 넣을게요.'])
  })

  it('does not keep an English progress line in a Korean thread, on screen or on disk', async () => {
    const store = createCometThreads()
    store.begin('1', 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘')
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: 'I\'ll read the file first.' })
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '', reset: true })
    store.handleEvent({ type: 'chat:token', channel: 'bot-1', text: '결정사항이랑 할 일 위주로 정리했어요.' })
    store.handleEvent({ type: 'chat:done', channel: 'bot-1', text: '결정사항이랑 할 일 위주로 정리했어요.' })
    expect(store.thread('1').messages.map(message => message.text)).toEqual(['fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', '결정사항이랑 할 일 위주로 정리했어요.'])
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
      expect((await readBotTranscript(paths, '9')).filter(turn => turn.progress).map(turn => turn.text)).toEqual(['월별 합계는 다 넣었어요.'])
    } finally { turnGoals.delete('bot-9'); await rm(root, { recursive: true, force: true }) }
  })
})

describe('short asks, statements and corrections', () => {
  it('takes a short ask to write, reword, pick, translate or recommend as a short ask', () => {
    for (const message of [
      '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', '방금 말한 거 더 짧게', '아 그 여행 가서 할 만한 거 세 개만 추천해줘', '이 문장 영어로 번역해줘', '둘 중에 하나 골라줘',
      '팀 회식 건배사 한 줄 지어줘', '좀 더 정중하게 바꿔줘', '강아지 이름 세 개만 추천해줘', '더 쉽게 설명해줘', 'Rewrite that in one line', 'Suggest three names for a cat',
    ]) { expect(shortAsk(message), message).toBe(true); expect(deskKind(message), message).toBe('ask'); expect(deskLane(message, true), message).toBe(true) }
    for (const message of [
      'fixtures/sales.csv에서 12월 매출 합계 알려줘', '회의록 파일 요약해서 써줘', '엔비디아 주가 검색해줘', '요즘 AI 뉴스 찾아줘', '오늘 서울 날씨 알려줘', '지민한테 문구 써달라고 해줘',
      '이 내용 민호한테 메일로 보내줘', '매주 월요일 9시에 요약해줘', '보고서 써줘', '내 이름 기억해줘',
      '지난 분기 실적을 지역별로 나눠서 왜 서울만 떨어졌는지 원인까지 붙여 가지고 경영진이 읽기 좋게 길게 풀어서 써줘', '첫 줄\n한 줄로 써줘', 'Write a report on Q3 sales',
    ]) expect(shortAsk(message), message).toBe(false)
    expect(deskKind('나 누구랑 일하지?')).toBe('question')
    expect(shortQuestion('방금 말한 거 더 짧게')).toBe(false)
    expect(SHORT_QUESTION_NOTE).toContain('Asked for one thing, give exactly one; asked for three, give three')
    expect(SHORT_QUESTION_NOTE).toContain('No other variants, background or tips unless they ask')
    expect(SHORT_QUESTION_NOTE).toContain('look something up only when they ask for current facts')
    for (const tool of ['search_web', 'open_page', 'read_pages', 'read_open_page', 'page_steps']) expect(DESK_TOOLS.ask!.has(tool), tool).toBe(false)
  })

  it('knows a statement that asks for nothing from a request, a question and a greeting', () => {
    for (const message of [
      '다음 주 목요일에 부모님 모시고 제주도 가. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어', '나 다음 달에 부산으로 이사 가게 됐어', '우리 팀장님이 이번 주 내내 휴가라서 결재가 좀 늦어질 것 같아',
      '오늘 발표 생각보다 잘 끝났어. 다들 반응이 좋았어', '요즘 야근이 많아서 너무 피곤해요', '어제 면접 봤는데 느낌이 나쁘지 않았어', "I'm moving to Busan next month for work",
    ]) expect(onlyTells(message), message).toBe(true)
    for (const message of [
      '다음 주 제주도 가는데 갈 만한 곳 추천해줘', '아빠 무릎이 안 좋은데 어디가 좋을까?', '제주도 날씨 알려줘', '부모님 모시고 갈 식당 찾아봐', '회의록 정리해서 팀에 공유해', '이 일정 어때',
      '지민한테 다음 주 행사 조사 맡겨', '서연은 이번 주부터 디자인 담당이야', '매주 월요일 아침에 요약해서 올려 놔',
      '아 그 사람 이름은 지민호 말고 김민호 대리야', '내 생일은 3월 12일이야 기억해', 'fixtures/notes.md는 지난주 회의 내용이야', '방금 만든 표에서 대구는 빼고 다시 해', '고마워 수고했어', '제주도 가', '안녕',
      "I'm going to Jeju, can you find a hotel?",
    ]) expect(onlyTells(message), message).toBe(false)
    expect(onlyTells('다음 주 목요일 오전 열 시 비행기로 가려고 해', '몇 시 비행기로 가세요?')).toBe(false)
    expect(TOLD_NOTE).toContain('use no tools')
    expect(source('ipc.ts')).toContain('short ? SHORT_QUESTION_NOTE : onlyTells(request.message) ? TOLD_NOTE : \'\'')
  })

  it('routes a correction the way the ask before it went', () => {
    for (const message of ['아 그거 말고 11월 걸로', '그냥 애플로 바꿔', '아니 그거 말고 지난주 걸로', '서울 말고 부산으로', '아 그거 대신 삼성전자로']) expect(isCorrection(message), message).toBe(true)
    for (const message of ['아 지민호 말고 민호야', '11월 매출 합계 알려줘', '서울 말고 다른 도시들 날씨도 전부 조사해서 지역별로 표 만들고 주말 예보까지 길게 붙여서 다시 정리해줘 그리고 대구도', '고마워']) expect(isCorrection(message), message).toBe(false)
    const earlier = [{ role: 'user', text: '엔비디아 오늘 주가 알려줘' }, { role: 'assistant', text: '162.85달러예요.' }]
    expect(routeAsk('그냥 애플로 바꿔', earlier)).toBe('엔비디아 오늘 주가 알려줘')
    expect(fastLane(routeAsk('그냥 애플로 바꿔', earlier), true)).toBe(true)
    const file = [{ role: 'user', text: 'fixtures/sales.csv에서 12월 매출 합계 알려줘' }, { role: 'assistant', text: '12월 합계는 1,310만 원이에요.' }]
    expect(deskKind(routeAsk('아 그거 말고 11월 걸로', file))).toBe('file')
    expect(routeAsk('아 그거 말고 11월 걸로', [])).toBe('아 그거 말고 11월 걸로')
    expect(routeAsk('아 지민호 말고 민호야', earlier)).toBe('아 지민호 말고 민호야')
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const routed = routeAsk(request.message, savedHistory)')
    expect(ipc).toContain('const lane = !company && fastLane(routed, plainAsk)')
  })
})

describe('desk tool menus', () => {
  it('keeps the check tool on every menu, so a check the person asked for can run on a desk turn', () => {
    const offered = (message: string): string[] => {
      const every = ['ppt_build', 'file_read', 'file_move', 'keep_in_mind', 'open_page', ...(asksForCheck(message) ? ['report_result_check'] : [])]
      const menu = DESK_TOOLS[deskKind(message) as keyof typeof DESK_TOOLS]!
      return every.filter(tool => menu.has(tool))
    }
    for (const [message, kind] of [['3분기 실적 PPT 5장 만들고 숫자 맞는지 확인까지 해줘', 'deck'], ['Build the Q3 deck and double-check the numbers', 'deck'], ['fixtures/inbox-dump 폴더 파일들 종류별로 정리하고 빠진 거 없는지 검증까지 해줘', 'tidy'], ['fixtures/meeting-notes.md 요약하고 한 번 더 확인해줘', 'note']] as const) {
      expect(deskKind(message), message).toBe(kind)
      expect(offered(message), message).toContain('report_result_check')
    }
    expect(offered('다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적')).not.toContain('report_result_check')
    for (const menu of Object.values(DESK_TOOLS)) { expect(menu.has('report_result_check')).toBe(true); expect(menu.size).toBeLessThanOrEqual(PRELOADED_TOOLS_MAX) }
    expect(source('ipc.ts')).toContain("...(!turn?.verification && !asksForCheck(turnGoals.get(channel) ?? '') ? [] : [resultCheckTool(")
  })

  it('gives a remember, tidy, note, short-ask and deck turn only its own tools, few enough to be preloaded', () => {
    const kinds: [string, string, string[]][] = [
      ['내 이름은 권윤재고 지민호랑 같이 일해. 기억해', 'keep', ['keep_in_mind']], ['아 지민호 말고 민호야', 'keep', ['keep_in_mind']], ['Remember that I work with Minho', 'keep', ['keep_in_mind']],
      ['fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', 'tidy', ['find_files', 'file_move', 'file_read']], ['Organize the files in the inbox folder by type', 'tidy', ['file_move']],
      ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', 'deck', ['ppt_build', 'file_read']], ['방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘', 'deck', ['file_read_package', 'file_edit_package']],
      ['fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', 'note', ['file_read']], ['fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘', 'note', ['file_read']], ['fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', 'note', ['file_read']],
      ['방금 말한 거 더 짧게', 'ask', []],
    ]
    for (const [message, kind, needs] of kinds) {
      expect(deskKind(message), message).toBe(kind)
      const menu = DESK_TOOLS[kind as keyof typeof DESK_TOOLS]!
      expect(menu.size, kind).toBeLessThanOrEqual(PRELOADED_TOOLS_MAX)
      for (const tool of needs) expect(menu.has(tool), `${kind}: ${tool}`).toBe(true)
    }
    expect([...DESK_TOOLS.keep!].sort()).toEqual(['keep_in_mind', 'read_note', 'report_result_check', 'search_chats', 'search_memory'])
    expect([...DESK_TOOLS.tidy!].sort()).toEqual(['file_move', 'file_read', 'find_files', 'report_result_check'])
    for (const tool of ['word_write', 'ppt_build', 'file_read', 'file_read_package', 'file_edit_package', 'file_create_workbook', 'file_read_workbook']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(true)
    expect(DESK_TOOLS.deck!.has('open_page')).toBe(false)
    expect(DESK_TOOLS.question).toBeUndefined()
    for (const message of ['회의록 요약해서 워드로 만들어서 민호한테 메일로 보내줘', '경쟁사 분석 자료 조사해서 정리해줘', '회의록 정리해서 민호한테 메일로 보내줘']) expect(deskKind(message), message).toBeUndefined()
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const desk = !!kind, deskMenu = kind && DESK_TOOLS[kind]')
    expect(ipc).toContain(': deskMenu ? closingBuilds(everyTool.filter(tool => deskMenu.has(tool.name))) : everyTool,')
  })

  it('ends a tidy-up with counts per kind and answers a note in the chat', () => {
    expect(DESK_NOTE).toContain('how many files went into each folder')
    expect(DESK_NOTE).toContain('File names are given only when they ask for them')
    expect(DESK_NOTE.match(/exactly one short offer line/g)).toHaveLength(1)
    expect(SHORT_QUESTION_NOTE).toContain('never a sentence that restates the ask or says what you are about to write')
    expect(DESK_NOTE).toContain('File names are given only when they ask for them')
    expect(DESK_NOTE).toContain('answered in the chat itself')
    expect(DESK_NOTE).toContain('with only what is in that file')
  })
})

describe('a delivered answer is shown alone', () => {
  const reason = 'Unverified collection items (2/6): 한라산: The cited observation does not establish this item\'s limitation.'
  const wrapped = `Not verified as complete.\n\n${reason}\n\nUnverified response:\n덜 걷는 곳으로 세 군데 골랐어요.\n\n1. 해안도로 드라이브`

  it('drops the model-facing reason from the thread and from a saved turn', () => {
    expect(answerOnly(wrapped)).toBe('덜 걷는 곳으로 세 군데 골랐어요.\n\n1. 해안도로 드라이브')
    expect(displayTaskAnswer(wrapped, 'ko')).toBe('덜 걷는 곳으로 세 군데 골랐어요.\n\n1. 해안도로 드라이브')
    expect(displayTaskAnswer(wrapped, 'ko')).not.toMatch(/Unverified|확인하지 못한|현재까지/)
    const empty = 'Not verified as complete.\n\nThe last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
    expect(answerOnly(empty)).toBe(empty)
    expect(displayTaskAnswer(empty, 'ko')).not.toMatch(/[A-Za-z]{4,}/)
    expect(answerOnly('PPT 5장 만들었어요.')).toBe('PPT 5장 만들었어요.')
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const answered = answerOnly(result.answer)')
    expect(ipc.indexOf('const answered = answerOnly(result.answer)')).toBeLessThan(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result'))
  })

  it('offers the check tool only when the person asked for a check, or on a check turn', () => {
    for (const message of ['PPT 만들고 숫자 맞는지 확인까지 해줘', '보고서 쓰고 검증도 해줘', '다 만든 다음에 한 번 더 확인해줘', '오타 없는지 제대로 검토해줘', 'Build the deck and double-check the numbers', 'Make the workbook, then verify it']) expect(asksForCheck(message), message).toBe(true)
    for (const message of ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', '오늘 서울 날씨 확인해줘', '내 일정 확인해줘', 'Check the weather in Seoul']) expect(asksForCheck(message), message).toBe(false)
    expect(source('ipc.ts')).toContain("...(!turn?.verification && !asksForCheck(turnGoals.get(channel) ?? '') ? [] : [resultCheckTool(turn?.verification ? {")
  })
})
