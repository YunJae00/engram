import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultPaths, type EngineCwd, type ToolSessionJob } from 'core'
import { FILE_JOB_RULE } from '../../../packages/core/src/agent-voice.js'

const fixture = vi.hoisted(() => ({
  query: vi.fn(), binary: vi.fn(), flog: vi.fn(), created: [] as string[],
  settings: { defaultEngine: 'codex', aiSelections: { filing: { engine: 'codex', model: 'chosen' } } },
}))
vi.mock('electron', () => ({ app: { getPath: (name: string) => join('C:/home', name), isPackaged: false } }))
vi.mock('../src/main/flog.js', () => ({ flog: fixture.flog }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => structuredClone(fixture.settings) }))
vi.mock('../src/main/brain-connections.js', () => ({ loadBrainConnections: async () => ({}), hasBrainConnection: () => false, probeConnection: vi.fn(), clearBrainConnection: vi.fn(), connectionEnvironment: () => ({}) }))
vi.mock('../src/main/claude-runtime.js', () => ({ afterFirstClaudeSession: async () => undefined, claudeSessionStarted: () => {}, installedClaudeBinary: fixture.binary, loadClaudeSdk: async () => ({ query: fixture.query }) }))
vi.mock('../src/main/engine-cloud.js', async original => ({ ...await original<typeof import('../src/main/engine-cloud.js')>(), claudeBinary: fixture.binary }))
vi.mock('../src/main/engine-claude-voice.js', () => ({
  VoiceSession: class { closed = false; spent = false; ready = true; key = ''; ask = async () => 'fixture line'; close(): void { this.closed = true } },
}))
vi.mock('../src/main/setup-connection.js', () => ({ verifySetupConnection: async () => undefined }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), createEngine: (id: string) => {
  fixture.created.push(id)
  return { id, detect: async () => ({ installed: true, loggedIn: true }), async *run() { yield { type: 'result', text: 'OK' } } }
} }))

import { chosenModel, ClaudeEngine, closeClaudeSessions, forSandbox, tierPurpose, trimWarm } from '../src/main/engine-claude.js'
import { SessionPool, signatureOf } from '../src/main/engine-claude-session.js'
import { beginFirstLine, cleanLine, endFirstLine, fallbackLine, FIRST_LINE_BUDGET_MS, FIRST_LINE_FALLBACK_MS, firstLineCarried, firstLinePrompt, firstLineNote, firstLineNow, firstLineReady, firstLineWaiting, laneLine, firstLineSaw, firstLineSpoke, greeting, quickAnswerPrompt, smallTalkAnswer, smallTalkPrompt, wantsFirstLine, warmFirstLine, type FirstLineAsk } from '../src/main/first-line.js'
import { withModelCallContext } from '../src/main/model-call-metrics.js'
import { cometNativeTools, commandSandbox, nativeDecision, type NativePolicy } from '../src/main/native-tools.js'
import { DEV_DEFAULTS } from '../src/main/dev-store.js'
import { workerPool } from '../src/main/worker-pool.js'
import { refreshEngines, resolveEngines } from '../src/main/vault.js'
import { checkAISelection } from '../src/main/check-ai.js'

const WORKDIR = 'C:/tmp' as EngineCwd
const source = (name: string): string => readFileSync(resolve(__dirname, '../src/main', name), 'utf8')
const tiers = (): { purpose: string; hint: string; model: string }[] => fixture.flog.mock.calls.filter(call => call[0] === 'model-tier').map(call => JSON.parse(call[1] as string))
const drain = async (events: AsyncIterable<unknown>): Promise<void> => { for await (const event of events) void event }

beforeEach(() => {
  vi.clearAllMocks(); fixture.created = []
  vi.stubEnv('ENGRAM_CLAUDE_MODEL', ''); vi.stubEnv('ENGRAM_ENGINE', 'auto')
  fixture.binary.mockReturnValue('fixture-claude')
  fixture.query.mockImplementation(async function* () { yield { type: 'result', subtype: 'success', result: 'fixture answer' } })
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); closeClaudeSessions() })

describe('three tiers', () => {
  it('maps hints to haiku, sonnet and opus, and only the dev variable overrides', () => {
    expect(chosenModel('fast')).toBe('haiku')
    expect(chosenModel('smart')).toBe('sonnet')
    expect(chosenModel()).toBe('opus')
    expect(chosenModel('default')).toBe('opus')
    expect(chosenModel('default', '0.3.299')).toBe('claude-opus-5-5')
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', 'forced')
    expect([chosenModel('fast'), chosenModel('smart'), chosenModel()]).toEqual(['forced', 'forced', 'forced'])
  })

  it('ignores a stored model and logs each call purpose with its resolved model', async () => {
    const engine = new ClaudeEngine('system')
    await drain(engine.run({ prompt: 'file this', workdir: WORKDIR, model: 'stored', modelHint: 'smart' }))
    expect(fixture.query.mock.calls[0]![0].options.model).toBe('sonnet')
    await drain(engine.run({ prompt: 'file this', workdir: WORKDIR, modelHint: 'fast' }))
    await tierPurpose.run('memory', () => drain(engine.run({ prompt: 'remember', workdir: WORKDIR, modelHint: 'fast' })))
    await withModelCallContext({ channel: 'background', purpose: 'comet-title' }, () => drain(engine.run({ prompt: 'title', workdir: WORKDIR, modelHint: 'fast' })))
    await withModelCallContext({ channel: 'background', purpose: 'memory-maintenance' }, () => drain(engine.run({ prompt: 'absorb', workdir: WORKDIR, modelHint: 'fast' })))
    await engine.quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })
    expect(tiers()).toEqual([
      { purpose: 'librarian', hint: 'smart', model: 'sonnet' },
      { purpose: 'librarian', hint: 'fast', model: 'haiku' },
      { purpose: 'memory', hint: 'fast', model: 'haiku' },
      { purpose: 'title', hint: 'fast', model: 'haiku' },
      { purpose: 'librarian', hint: 'fast', model: 'haiku' },
      { purpose: 'first-line', hint: 'fast', model: 'haiku' },
    ])
    expect(source('engine-claude.ts')).toContain("tier('work', chosenModel(job.modelHint), job.modelHint)")
    expect(chosenModel(undefined)).toBe(chosenModel())
    expect(chosenModel('smart')).toBe('sonnet')
    expect(source('ipc.ts')).toContain("tierPurpose.run('memory', () => rememberTurn(")
  })

  it('counts a live voice as one warm runtime under the cap', async () => {
    const trim = vi.spyOn(SessionPool.prototype, 'trim')
    trimWarm()
    expect(trim).toHaveBeenLastCalledWith(workerPool.target + 1)
    await new ClaudeEngine('system').quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })
    trimWarm()
    expect(trim).toHaveBeenLastCalledWith(workerPool.target)
  })
})

describe('instant first line', () => {
  const ask = (patch: Partial<FirstLineAsk> = {}): FirstLineAsk => ({ channel: 'bot-1', message: '지난 분기 매출 보고서를 표로 정리해줘', korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, ...patch })
  const voice = (answer: () => Promise<string>) => ({ id: 'claude' as const, quick: vi.fn(answer) })
  const later = (text: string, ms: number) => () => new Promise<string>(done => setTimeout(() => done(text), ms))
  const begin = (engine: unknown, patch: Partial<FirstLineAsk> = {}, signal = new AbortController().signal) => {
    const show = vi.fn(), getter = vi.fn(async () => engine as never)
    beginFirstLine({ ...ask(patch), engine: getter, workdir: WORKDIR, signal, show })
    return { show, getter }
  }
  beforeEach(() => { vi.useFakeTimers(); endFirstLine('bot-1') })

  it('shows the line as soon as it arrives while the answer is silent, and tells the main turn', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 300)))
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(show).toHaveBeenCalledExactlyOnceWith('보고서를 표로 정리해드릴게요.')
    expect(firstLineNote('bot-1')).toContain('보고서를 표로 정리해드릴게요.')
    await vi.advanceTimersByTimeAsync(5000)
    expect(show).toHaveBeenCalledOnce()
  })

  it('opens a lookup turn with its own first line at once, without asking the small model', async () => {
    const start = (engine: unknown, line?: string, patch: Partial<FirstLineAsk> = {}) => {
      const show = vi.fn()
      beginFirstLine({ ...ask({ message: '오늘 서울 날씨 어때?', ...patch }), engine: async () => engine as never, workdir: WORKDIR, signal: new AbortController().signal, show, ...(line ? { line } : {}) })
      return show
    }
    for (const live of [voice(later('NONE', 600)), voice(later('서울 날씨를 알려드릴게요.', 300)), voice(() => Promise.reject(new Error('down')))]) {
      endFirstLine('bot-1')
      const show = start(live, '지금 날씨 확인할게요.')
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(show).toHaveBeenCalledExactlyOnceWith('지금 날씨 확인할게요.')
      expect(live.quick).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toContain('지금 날씨 확인할게요.')
      expect(firstLineCarried('bot-1')).toBe('지금 날씨 확인할게요.')
      expect(firstLineWaiting('bot-1')).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(show).toHaveBeenCalledOnce()
    }

    endFirstLine('bot-1')
    let show = start(voice(later('NONE', 600)), '지금 날씨 확인할게요.')
    firstLineSpoke('bot-1')
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
    expect(show).not.toHaveBeenCalled()
    endFirstLine('bot-1')
    show = start(voice(later('NONE', 600)), '지금 날씨 확인할게요.')
    await vi.advanceTimersByTimeAsync(600)
    expect(show).not.toHaveBeenCalled()
    firstLineReady('bot-1')
    expect(show).toHaveBeenCalledExactlyOnceWith('지금 날씨 확인할게요.')

    endFirstLine('bot-1')
    show = start(voice(later('NONE', 600)))
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
    expect(show).not.toHaveBeenCalled()
    for (const [engine, patch] of [[voice(later('NONE', 600)), { message: '안녕' }], [{ id: 'mock', quick: async () => 'x' }, {}], [voice(later('NONE', 600)), { interactive: false }]] as const) {
      endFirstLine('bot-1')
      show = start(engine, '지금 날씨 확인할게요.', patch)
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
      expect(show).not.toHaveBeenCalled()
    }
  })

  it('answers a short general-knowledge question whole from the quick voice, and leaves it to the main turn on NONE', async () => {
    const start = (engine: unknown, patch: Partial<FirstLineAsk> = {}, whole = true) => {
      const show = vi.fn()
      beginFirstLine({ ...ask({ message: '1년은 몇 초야?', ...patch }), engine: async () => engine as never, workdir: WORKDIR, signal: new AbortController().signal, show, whole })
      return show
    }
    const live = voice(later('1년은 31,536,000초예요.', 900))
    let show = start(live)
    firstLineReady('bot-1')
    const reply = smallTalkAnswer('bot-1')
    await vi.advanceTimersByTimeAsync(900)
    expect(await reply).toBe('1년은 31,536,000초예요.')
    expect(live.quick.mock.calls[0]![0]).toBe(quickAnswerPrompt('1년은 몇 초야?', true))
    expect(quickAnswerPrompt('1년은 몇 초야?', true)).toContain('reply with exactly NONE')
    expect(show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
    for (const engine of [voice(async () => 'NONE'), voice(later('31,536,000초예요.', 5000)), voice(async () => { throw new Error('down') }), voice(async () => '여러 줄\n답')]) {
      endFirstLine('bot-1')
      show = start(engine)
      firstLineReady('bot-1')
      const none = smallTalkAnswer('bot-1')
      await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
      expect(await none).toBeUndefined()
      expect(show).not.toHaveBeenCalled()
    }
    endFirstLine('bot-1')
    show = start(voice(later('매출을 표로 정리해드릴게요.', 300)), { message: '지난 분기 매출 보고서를 표로 정리해줘' }, false)
    firstLineReady('bot-1')
    expect(await smallTalkAnswer('bot-1')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    expect(show).toHaveBeenCalledExactlyOnceWith('매출을 표로 정리해드릴게요.')
    endFirstLine('bot-1')
    const idle = voice(async () => '31,536,000초예요.')
    start(idle, { followUp: true })
    expect(await smallTalkAnswer('bot-1')).toBeUndefined()
    expect(idle.quick).not.toHaveBeenCalled()
  })

  describe('a turn asked for a whole answer also gets the voice\'s own first line', () => {
    const QUESTION = '마라톤 풀코스는 몇 미터야?'
    const HOST = '호스트가 고른 줄이에요.'
    const byPrompt = (whole: () => Promise<string>, line: () => Promise<string>) => voice(async () => 'unused').quick.mockImplementation(((prompt: string) => prompt.includes('You write the assistant\'s first line') ? line() : whole()) as never)
    const run = (quick: ReturnType<typeof byPrompt>, patch: Partial<FirstLineAsk> = {}, more: { told?: boolean; said?: () => Promise<readonly string[]> } = {}) => {
      const show = vi.fn()
      beginFirstLine({ ...ask({ message: QUESTION, ...patch }), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, whole: !more.told, fallback: HOST, ...more })
      firstLineReady('bot-1')
      return { show, reply: smallTalkAnswer('bot-1') }
    }

    it('shows the voice line unchanged when the voice declines the whole answer, and never the host line', async () => {
      for (const whole of [async () => 'NONE', later('42,195미터예요.', 4000), async () => { throw new Error('down') }]) {
        endFirstLine('bot-1')
        const quick = byPrompt(whole, later('코스 기록부터 찾아볼게요.', 400))
        const { show, reply } = run(quick)
        await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
        expect(await reply).toBeUndefined()
        expect(show).toHaveBeenCalledExactlyOnceWith('코스 기록부터 찾아볼게요.')
        expect(quick.mock.calls.map(call => (call as unknown[])[0])).toEqual(expect.arrayContaining([quickAnswerPrompt(QUESTION, true), firstLinePrompt(QUESTION, true)]))
        expect(firstLineNote('bot-1')).toContain('"코스 기록부터 찾아볼게요."')
      }
      endFirstLine('bot-1')
      const told = run(byPrompt(async () => 'NONE', later('일정표부터 맞춰 볼게요.', 300)), { message: '다음 달에 이사해요' }, { told: true })
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(await told.reply).toBeUndefined()
      expect(told.show).toHaveBeenCalledExactlyOnceWith('일정표부터 맞춰 볼게요.')
    })

    it('lets a whole answer in time be the reply, and the late first line changes nothing', async () => {
      const quick = byPrompt(later('42,195미터예요.', 300), later('코스 기록부터 찾아볼게요.', 900))
      const { show, reply } = run(quick)
      await vi.advanceTimersByTimeAsync(300)
      expect(await reply).toBe('42,195미터예요.')
      await vi.advanceTimersByTimeAsync(3000)
      expect(show).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
      expect(firstLineCarried('bot-1')).toBeUndefined()
    })

    it('posts a line that ends like the earlier ones, or names no split on a split ask, exactly as written', async () => {
      const said = async () => ['가계부부터 열어 볼게요.', '영수증부터 모아 볼게요.']
      const repeat = run(byPrompt(async () => 'NONE', later('통장 내역부터 모아 볼게요.', 200)), { message: '이번 달 카드값 얼마 나왔는지 정리해줘' }, { said })
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(repeat.show).toHaveBeenCalledExactlyOnceWith('통장 내역부터 모아 볼게요.')
      endFirstLine('bot-1')
      const split = vi.fn(later('후보지 목록부터 뽑을게요.', 200))
      const show = vi.fn()
      beginFirstLine({ ...ask({ message: '캠핑장 네 곳 후기는 한 곳씩 나눠서 검색시켜' }), engine: async () => ({ id: 'claude' as const, quick: split }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, fallback: HOST })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(show).toHaveBeenCalledExactlyOnceWith('후보지 목록부터 뽑을게요.')
    })

    it('still puts the host line up at the fallback time when the voice gives nothing for either call', async () => {
      const { show, reply } = run(byPrompt(later('42,195미터예요.', 5000), later('코스 기록부터 찾아볼게요.', 5000)))
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS - 1)
      expect(show).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await reply).toBeUndefined()
      expect(show).toHaveBeenCalledExactlyOnceWith(HOST)
      await vi.advanceTimersByTimeAsync(5000)
      expect(show).toHaveBeenCalledOnce()
    })

    it('shows the voice its earlier lines and keeps NONE for small talk only', () => {
      const prompt = firstLinePrompt('이 사진 배경 지워줄 수 있어?', true, ['파일부터 열어 볼게요.'])
      expect(prompt).toContain('Your first lines earlier in this conversation: "파일부터 열어 볼게요."')
      expect(prompt).toContain('Only if the request is small talk, a greeting or thanks, reply with exactly NONE.')
      expect(prompt).toContain('A question or an unclear request gets its first step like any other request.')
      expect(prompt).not.toContain('one sentence fully answers')
      expect(prompt).not.toContain('cannot tell')
    })
  })

  it('never holds the main turn: the note is read without waiting and the turn races the line', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const firstSaid = firstLineNote(channel)')
    expect(ipc).not.toMatch(/await firstLine/)
    expect(ipc).toMatch(/attachmentContext: \[[^\n]*firstSaid\]/)
    expect(ipc).toContain('onToken: (text) => { if (!quiet) firstLineSpoke(channel);')
    expect(ipc).toContain('const shown = (text: string): void => { firstLineSpoke(channel); broadcast({ type: \'chat:token\', channel, text }) }')
    expect(ipc.indexOf('beginFirstLine({')).toBeLessThan(ipc.indexOf('handleChatSend(request, controller.signal'))
  })

  it('asks the first-line voice for its sentence without thinking', () => {
    expect(source('engine-claude-voice.ts')).toContain("thinking: { type: 'disabled' }")
    expect(FIRST_LINE_BUDGET_MS).toBe(1500)
  })

  it('holds a line that comes before the request is saved, and shows it right after', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 100)))
    await vi.advanceTimersByTimeAsync(100)
    expect(show).not.toHaveBeenCalled()
    firstLineReady('bot-1')
    expect(show).toHaveBeenCalledExactlyOnceWith('보고서를 표로 정리해드릴게요.')
    expect(firstLineNote('bot-1')).toContain('보고서를 표로 정리해드릴게요.')
  })

  it('shows a line that arrives after the main prompt was built, and that prompt is told a line may be up', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 300)))
    firstLineReady('bot-1')
    const note = firstLineNote('bot-1')
    expect(note).toContain('is already on screen')
    expect(note).toContain('Do not open with a greeting or a restatement')
    expect(note).toContain('Write nothing before your first tool call and nothing between tool calls')
    await vi.advanceTimersByTimeAsync(300)
    expect(show).toHaveBeenCalledExactlyOnceWith('보고서를 표로 정리해드릴게요.')
    expect(firstLineCarried('bot-1')).toBe('보고서를 표로 정리해드릴게요.')
  })

  it('drops a line still on its way once the answer says its first word, and adds no note when no line is asked for', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 300)))
    firstLineReady('bot-1')
    firstLineNote('bot-1')
    firstLineSpoke('bot-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
    endFirstLine('bot-1')
    begin(voice(later('x', 10)), { message: '안녕' })
    expect(firstLineNote('bot-1')).toBe('')
  })

  it('keeps the shown line on screen until a reset freezes it or the answer replaces it, and never adds it to the answer', async () => {
    begin(voice(later('보고서를 정리해드릴게요.', 10)))
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(firstLineCarried('bot-1')).toBe('보고서를 정리해드릴게요.')
    firstLineSaw({ type: 'chat:token', channel: 'bot-2', text: '', reset: true })
    expect(firstLineCarried('bot-1')).toBe('보고서를 정리해드릴게요.')
    firstLineSaw({ type: 'chat:token', channel: 'bot-1', text: '', reset: true })
    expect(firstLineCarried('bot-1')).toBeUndefined()
  })

  it('wires the line into the answer stream after the saved request, with no reset of its own', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain("show: line => broadcast({ type: 'chat:token', channel: entry.channel, text: `${line}\\n\\n` }), hide: () => broadcast({ type: 'chat:token', channel: entry.channel, text: '', reset: true, drop: true }) })")
    expect(ipc.indexOf('recordedRequests.add(request)')).toBeLessThan(ipc.indexOf('firstLineReady(channel)'))
    expect(ipc.indexOf('firstLineReady(channel)')).toBeLessThan(ipc.indexOf('const firstSaid = firstLineNote(channel)'))
    expect(ipc).toContain('extractChatCaptures(finishProgress(channel, rawText))')
    expect(ipc).not.toContain('withFirstLine')
    expect(ipc).toContain('tapBroadcast(firstLineSaw)')
  })

  it('opens the turn with the host\'s own line when the small model says NONE, fails or is late, and never holds a whole reply past that', async () => {
    const start = (engine: unknown, patch: Partial<FirstLineAsk> = {}, more: { whole?: boolean } = {}) => {
      const show = vi.fn(), message = patch.message ?? '내 이름은 권윤재고 지민호랑 같이 일해. 기억해'
      beginFirstLine({ ...ask({ ...patch, message }), engine: async () => engine as never, workdir: WORKDIR, signal: new AbortController().signal, show, fallback: fallbackLine(message, patch.korean ?? true), ...more })
      firstLineReady('bot-1')
      return show
    }
    let show = start(voice(later('NONE', 600)))
    await vi.advanceTimersByTimeAsync(600)
    expect(show).toHaveBeenCalledExactlyOnceWith('바로 적어 둘게요.')
    expect(firstLineNote('bot-1')).toContain('바로 적어 둘게요.')
    expect(firstLineWaiting('bot-1')).toBe(true)
    endFirstLine('bot-1')
    show = start(voice(later('회의록을 요약해드릴게요.', 1400)), { message: 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘' })
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS - 1)
    expect(show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(show).toHaveBeenCalledExactlyOnceWith('파일부터 확인할게요.')
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).toHaveBeenCalledOnce()
    expect(FIRST_LINE_FALLBACK_MS).toBeLessThanOrEqual(1500)
    endFirstLine('bot-1')
    show = start(voice(async () => { throw new Error('voice down') }), { message: 'Who do I work with?', korean: false })
    await vi.advanceTimersByTimeAsync(10)
    expect(show).toHaveBeenCalledExactlyOnceWith('Checking now.')
    endFirstLine('bot-1')
    show = start(voice(later('회의록부터 읽어볼게요.', 900)))
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).toHaveBeenCalledExactlyOnceWith('회의록부터 읽어볼게요.')
    for (const [reply, ms, at] of [['NONE', 600, 600], ['1년은 31,536,000초예요.', 1400, FIRST_LINE_FALLBACK_MS]] as const) {
      endFirstLine('bot-1')
      show = start(voice(later(reply, ms)), { message: '1년은 몇 초야?' }, { whole: true })
      const whole = smallTalkAnswer('bot-1')
      await vi.advanceTimersByTimeAsync(at)
      expect(await whole).toBeUndefined()
      expect(show).toHaveBeenCalledExactlyOnceWith('바로 확인해 볼게요.')
      await vi.advanceTimersByTimeAsync(3000)
      expect(show).toHaveBeenCalledOnce()
    }
    endFirstLine('bot-1')
    show = start(voice(later('NONE', 600)))
    firstLineSpoke('bot-1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).not.toHaveBeenCalled()
    endFirstLine('bot-1')
    show = start(voice(later('NONE', 600)), { message: '안녕' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).not.toHaveBeenCalled()
    for (const message of ['아 지민호 말고 민호야', '나 누구랑 일하지?', '정리한 폴더에 PDF 몇 개야?']) expect(fallbackLine(message, true)).not.toMatch(/[A-Za-z]|알겠|네,/)
    expect(firstLinePrompt('엔비디아 오늘 주가 알려줘', true)).toContain('names the first concrete thing')
    expect(firstLinePrompt('엔비디아 오늘 주가 알려줘', true)).toContain('Do not restate the request')
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).toContain('fallback: said => fallbackLine(request.message, threadKorean(request.message, request.history ?? []), said), show:')
  })

  it('drops a line that misses the budget', async () => {
    const { show } = begin(voice(later('늦은 줄입니다.', 2000)))
    await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
    expect(firstLineNote('bot-1')).toBe('')
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).not.toHaveBeenCalled()
  })

  it('drops the line when the answer speaks first', async () => {
    const { show } = begin(voice(later('보고서를 정리해드릴게요.', 300)))
    firstLineSpoke('bot-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
  })

  it('the team lane says a fixed Korean line at once, and the small model\'s late line is never shown over it', async () => {
    const { show } = begin(voice(later('지민을 추가할게요.', 300)), { message: '지민 하나 추가해줘. 리서치 담당이야' })
    firstLineReady('bot-1')
    firstLineNow('bot-1', '지민 하나 추가해줘. 리서치 담당이야', true)
    expect(show).toHaveBeenCalledExactlyOnceWith('바로 팀에 넣을게요.')
    expect(firstLineNote('bot-1')).toContain('바로 팀에 넣을게요.')
    expect(firstLineCarried('bot-1')).toBe('바로 팀에 넣을게요.')
    expect(firstLineWaiting('bot-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).toHaveBeenCalledOnce()
    expect(laneLine('지우 무슨 일 하는 사람이야?', true)).toBe('지금 확인해 볼게요.')
    expect(laneLine('내 일정 뭐 있어?', true)).toBe('지금 확인해 볼게요.')
    expect(laneLine('이번 주 팀이 한 일 요약해', true)).toBe('지금 정리할게요.')
    expect(laneLine('서연은 빼고 지민은 이름을 지우로 바꿔', true)).toBe('바로 정리할게요.')
    expect(laneLine('박사원 내보내고 김대리는 김과장으로 승진시켜', true)).toBe('바로 정리할게요.')
    expect(laneLine('지민이는 날씨 찾아보고 서연이는 문구 써줘. 둘한테 나눠 맡겨', true)).toBe('누가 뭘 맡을지 나눠 볼게요.')
    expect(laneLine('이 조사는 도윤한테 맡겨줘', true)).toBe('바로 맡길게요.')
    expect(laneLine('매주 월요일 아침 9시에 주간보고 올려', true)).toBe('일정에 넣어 둘게요.')
    expect(laneLine('이것 좀 해줘', true)).toBe('지금 바로 할게요.')
    for (const said of ['김대리 하나 뽑아줘', '내 일정 뭐 있어?', '이것 좀 해줘']) expect(laneLine(said, true)).not.toMatch(/^네[,.]|알겠습니다|습니다/)
    expect(laneLine('Hand this to Kim: next month\'s events', false)).toBe('On it.')
    expect(source('ipc.ts')).toMatch(/if \(company && !handed && !summing && !turn\?\.report\) firstLineNow\(channel, [^\n]*\n\s*const firstSaid = firstLineNote\(channel\)/)
    expect(source('ipc.ts')).toMatch(/const handoff = company && chief && !turn\?\.report && request\.scheduled !== true \? plainHandoff\(request\.message, /)
    expect(source('ipc.ts')).toMatch(/const kept = !handoff && !hire && !split && !change && company && chief && !turn\?\.report && request\.scheduled !== true \? plainSchedule\(request\.message\) : undefined/)
    expect(source('ipc.ts')).toMatch(/const direct = handoff \? \{ tool: 'assign', args: handoff \} : split \? \{ tool: 'assign', args: split \} : hire \? \{ tool: 'agents', args: hire \} : change \? \{ tool: 'agents', args: change \} : kept \? \{ tool: 'schedule', args: kept \} : undefined/)
    expect(source('ipc.ts')).toMatch(/handed \? \{ answer: handed, steps: direct \? \[\{ tool: direct\.tool, args: direct\.args, observation: handed \}\] : \[\], fellBack: false \} : fixed \? /)
    expect(source('ipc.ts')).toMatch(/const hire = !handoff && company && chief && !turn\?\.report && request\.scheduled !== true \? plainHire\(request\.message\) : undefined/)
    expect(source('ipc.ts')).toMatch(/const reporting = !direct && company && turn\?\.report \? \(await listTasks\(paths\)\)\.find\(task => task\.state === 'running' && task\.botId === bot\.id\) : undefined/)
    expect(source('ipc.ts')).toMatch(/: !company \|\| turn\?\.report \? undefined\n[^\n]*: summing \? await teamSummary\(paths, [^\n]*\n\s*: aboutEmployee\(request\.message, everyone, await listTasks\(paths\)\)\n\s*const handedBack = employeesAnswer\(reporting\)/)
    expect(source('ipc.ts')).toContain('handedBack ? `${HANDED_BACK}\\n${handedBack}` : \'\'')
    expect(source('ipc.ts')).toMatch(/const summing = !direct && !!company && chief && !turn\?\.report && isTeamWorkAsk\(request\.message\) && \(request\.scheduled === true \|\| !isDutyAsk\(request\.message\)\)\n\s*if \(summing\) firstLineNow\(/)
    expect(source('ipc.ts')).not.toMatch(/lastTeamResult|REPORT_WRITER_MS/)
    expect(source('ipc.ts').slice(source('ipc.ts').indexOf('await lookup.run('), source('ipc.ts').indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  })

  it('an ask the host answers itself is decided before the first line and shows none', async () => {
    const ask = { channel: 'bot-1', message: '지우 무슨 일 하는 사람이야?', korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false }
    expect(wantsFirstLine(ask)).toBeNull()
    expect(wantsFirstLine({ ...ask, host: true })).toBe('host')
    vi.useFakeTimers()
    try {
      const show = vi.fn(), quick = vi.fn(async () => '지금 확인해 볼게요.')
      beginFirstLine({ ...ask, host: true, engine: async () => ({ id: 'claude', quick }), workdir: '/tmp' as never, signal: new AbortController().signal, show, fallback: '바로 확인해 볼게요.' })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS + 1000)
      firstLineNow('bot-1', ask.message, true)
      expect(show).not.toHaveBeenCalled()
      expect(quick).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    } finally { vi.useRealTimers(); endFirstLine('bot-1') }
    const ipc = source('ipc.ts'), decided = ipc.indexOf('const hostAnswers = '), begun = ipc.indexOf('beginFirstLine({ host: hostAnswers,')
    expect(decided).toBeGreaterThan(0)
    expect(begun).toBeGreaterThan(decided)
    expect(ipc.slice(decided, begun)).toContain('answersItself(request.message, bots, lastReplyOf(request.history))')
    expect(ipc.slice(decided, begun)).toMatch(/\.primary === true && \(answersItself/)
    expect(ipc.slice(decided, begun)).toContain('() => false)')
  })

  it('the lane says nothing where no first line is wanted: a report turn, the status question, a stopped turn', () => {
    for (const patch of [{ interactive: false }, { message: '다들 뭐하고 있어?' }, { followUp: true }, { secret: true }]) {
      const { show } = begin(voice(async () => 'x'), patch)
      firstLineReady('bot-1')
      firstLineNow('bot-1', patch.message ?? '지민 하나 추가해줘', true)
      expect(show, JSON.stringify(patch)).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    }
    const abort = new AbortController()
    const { show } = begin(voice(later('x', 300)), {}, abort.signal)
    firstLineReady('bot-1')
    abort.abort()
    firstLineNow('bot-1', '지민 하나 추가해줘', true)
    expect(show).not.toHaveBeenCalled()
  })

  it('starts no first line for the team status question, however fast the small model is', async () => {
    for (const message of ['다들 뭐하고 있어?', '팀원들 지금 뭐 하고 있어요?', '현황']) {
      expect(wantsFirstLine(ask({ message })), message).toBe('status')
      const live = voice(async () => '팀 현황을 알려드릴게요.')
      const { show } = begin(live, { message })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(2000)
      expect(live.quick).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    }
    expect(wantsFirstLine(ask({ message: '다들 뭐하고 있는지 표로 정리해서 메일로 보내줘' }))).toBeNull()
  })

  it('skips chit-chat, one-line questions and ineligible turns without resolving the engine', async () => {
    const skipped: Partial<FirstLineAsk>[] = [
      { message: 'ㅇㅇ' }, { message: '??' }, { message: '👍' }, { message: 'ok' }, { message: '네!' }, { message: '좋아요' }, { message: 'sure' },
      { studying: true }, { limited: true }, { followUp: true }, { interactive: false }, { secret: true }, { message: '/tidy the inbox now please' }, { channel: 'panel' }, { channel: 'new-comet' },
    ]
    for (const patch of skipped) {
      expect(wantsFirstLine(ask(patch)), JSON.stringify(patch)).not.toBeNull()
      const live = voice(async () => '줄')
      const { show, getter } = begin(live, patch)
      await vi.advanceTimersByTimeAsync(2000)
      expect(getter).not.toHaveBeenCalled()
      expect(live.quick).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
    }
    expect(wantsFirstLine(ask())).toBeNull()
    expect(wantsFirstLine(ask({ message: 'Summarize the attached contract and list the risks', korean: false }))).toBeNull()
    for (const message of ['메일 써줘', '소설 써줘', 'help', 'Can you draft the Q3 report?', 'ok, draft the report', 'What is 2+2?', '고마워, 이제 계약서 요약해줘']) expect(wantsFirstLine(ask({ message, korean: false })), message).toBeNull()
  })

  it('answers a greeting or thanks whole from the quick voice, once, and never an affirmation or a job', async () => {
    for (const message of ['안녕', '안녕하세요!', 'thanks!', 'Thanks for your help', '고마워요 잘 됐어요', 'How are you?', "what's up", '잘 지냈어요?', 'how are you doing today?', '감사합니다']) {
      expect(greeting(message), message).toBe(true)
      expect(wantsFirstLine(ask({ message })), message).toBe('chit-chat')
      endFirstLine('bot-1')
      const live = voice(later('안녕하세요! 오늘은 무엇을 도와드릴까요?', 900))
      const { show } = begin(live, { message })
      firstLineReady('bot-1')
      const reply = smallTalkAnswer('bot-1')
      await vi.advanceTimersByTimeAsync(900)
      expect(await reply, message).toBe('안녕하세요! 오늘은 무엇을 도와드릴까요?')
      expect(live.quick.mock.calls[0]![0]).toContain('small talk')
      expect(live.quick.mock.calls[0]![0]).toContain('never ask or offer help in any wording')
      expect(show).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
      expect(firstLineCarried('bot-1')).toBeUndefined()
    }
    expect(FIRST_LINE_BUDGET_MS).toBeLessThan(2000)
    expect(smallTalkPrompt('안녕', true)).toContain('Korean, polite -요 form')
    for (const message of ['네', 'ok', '좋아', 'ㅇㅇ', '👍', '안녕, 계약서 요약해줘', '고마워, 이제 계약서 요약해줘', '오늘 서울 날씨 어때?']) {
      expect(greeting(message), message).toBe(false)
      endFirstLine('bot-1')
      begin(voice(async () => '네, 진행할게요.'), { message })
      expect(await smallTalkAnswer('bot-1'), message).toBeUndefined()
    }
    const stop = new AbortController()
    for (const [engine, signal] of [[voice(later('안녕하세요!', 5000))], [voice(async () => 'NONE')], [voice(async () => { throw new Error('voice down') })], [voice(later('안녕하세요!', 500)), stop.signal], [{ id: 'mock', quick: async () => '안녕하세요!' }], [undefined]] as const) {
      endFirstLine('bot-1')
      begin(engine, { message: '안녕' }, signal)
      const reply = smallTalkAnswer('bot-1')
      if (signal) stop.abort()
      await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
      expect(await reply).toBeUndefined()
    }
    for (const patch of [{ followUp: true }, { interactive: false }, { studying: true }, { limited: true }, { channel: 'panel' }]) {
      endFirstLine('bot-1')
      const live = voice(async () => '안녕하세요!')
      begin(live, { message: '안녕', ...patch })
      expect(await smallTalkAnswer(patch.channel ?? 'bot-1')).toBeUndefined()
      expect(live.quick).not.toHaveBeenCalled()
    }
  })

  it('stays silent for mock or missing engines, NONE answers and failures', async () => {
    for (const engine of [undefined, { id: 'mock' }, { id: 'mock', quick: async () => '줄' }, voice(async () => 'NONE'), voice(async () => { throw new Error('voice down') })]) {
      const { show } = begin(engine)
      await vi.advanceTimersByTimeAsync(2000)
      expect(show).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    }
    expect(cleanLine('"정리해드릴게요."')).toBe('정리해드릴게요.')
    expect([cleanLine('none.'), cleanLine('a\nb'), cleanLine('x'.repeat(141)), cleanLine('  ')]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('drops a pending line on stop and at turn end', async () => {
    const stop = new AbortController()
    const stopped = begin(voice(later('정리해드릴게요.', 300)), {}, stop.signal)
    stop.abort()
    await vi.advanceTimersByTimeAsync(1000)
    expect(stopped.show).not.toHaveBeenCalled()
    const ended = begin(voice(later('정리해드릴게요.', 300)))
    endFirstLine('bot-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(ended.show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
  })

  it('opens no voice where the first line is skipped', () => {
    expect(source('ipc.ts')).not.toContain('warmQuick')
    expect(source('index.ts')).not.toContain('warmQuick')
  })

  it('opens the voice ahead for the channels that say first lines, and only for Claude', async () => {
    const warm = vi.fn(async () => undefined)
    warmFirstLine({ id: 'claude', warmQuick: warm }, WORKDIR)
    expect(warm).toHaveBeenCalledExactlyOnceWith(WORKDIR)
    warmFirstLine({ id: 'mock', warmQuick: warm } as never, WORKDIR)
    warmFirstLine(undefined, WORKDIR)
    vi.stubEnv('ENGRAM_ENGINE', 'mock')
    warmFirstLine({ id: 'claude', warmQuick: warm }, WORKDIR)
    expect(warm).toHaveBeenCalledOnce()
    expect(source('index.ts')).toContain('warmFirstLine(live, engineCwd(ctx.paths))')
  })

  it('replaces a voice whose answer never came, so the next line finds a fresh one', async () => {
    const engine = new ClaudeEngine('profile-late')
    const voiceOf = (): Promise<{ closed: boolean; ready: boolean; ask(): Promise<string> }> => (engine as unknown as { voiceFor(w: string): Promise<never> }).voiceFor(WORKDIR)
    const stuck = await voiceOf()
    stuck.ask = async () => { stuck.ready = false; throw new Error('The voice took too long.') }
    await expect(engine.quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })).rejects.toThrow('too long')
    expect(stuck.closed).toBe(true)
    const fresh = await voiceOf()
    expect(fresh).not.toBe(stuck)
    expect(await engine.quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })).toBe('fixture line')
  })

  it('opens two quick voices ahead, so a turn\'s two quick calls both land on a warm one', async () => {
    const engine = new ClaudeEngine('profile-two')
    const lane = (one: number): Promise<{ closed: boolean }> => (engine as unknown as { voiceFor(w: string, l: number): Promise<never> }).voiceFor(WORKDIR, one)
    const trim = vi.spyOn(SessionPool.prototype, 'trim')
    await engine.warmQuick(WORKDIR)
    trimWarm()
    const lanes = Math.min(2, Math.max(1, workerPool.target))
    expect(trim).toHaveBeenLastCalledWith(workerPool.target + 1 - lanes)
    const first = await lane(lanes - 1)
    expect(first.closed).toBe(false)
    expect(await lane(lanes - 1)).toBe(first)
  })

  it('keeps one voice per Claude account, so a switch never answers from the old one', async () => {
    const opened: unknown[] = []
    const a = new ClaudeEngine('profile-a'), b = new ClaudeEngine('profile-b')
    await a.warmQuick(WORKDIR)
    opened.push(await (a as unknown as { voiceFor(w: string): Promise<unknown> }).voiceFor(WORKDIR))
    opened.push(await (a as unknown as { voiceFor(w: string): Promise<unknown> }).voiceFor(WORKDIR))
    const other = await (b as unknown as { voiceFor(w: string): Promise<unknown> }).voiceFor(WORKDIR)
    expect(opened[0]).toBe(opened[1])
    expect(other).not.toBe(opened[0])
    expect((opened[0] as { closed: boolean }).closed).toBe(true)
  })
})

describe('no Codex on in-app paths', () => {
  it('builds background engines as Claude whatever is stored', async () => {
    expect((await resolveEngines()).map(engine => engine.id)).toEqual(['claude'])
    const ctx = { engines: [] } as unknown as Parameters<typeof refreshEngines>[0]
    expect((await refreshEngines(ctx, true)).map(engine => engine.id)).toEqual(['claude'])
    expect((await refreshEngines(ctx, true)).map(engine => engine.id)).toEqual(['claude'])
    await checkAISelection()
    expect(fixture.created.length).toBeGreaterThanOrEqual(3)
    expect(new Set(fixture.created)).toEqual(new Set(['claude']))
  })

  it('defaults developer mode to Claude', () => { expect(DEV_DEFAULTS.provider).toBe('claude') })
})

describe('Claude command sandbox', () => {
  let root: string, cwd: string
  const policy = (patch: Partial<NativePolicy>): NativePolicy => ({ cwd, roots: [cwd], privateDir: join(root, 'private'), commands: { allowed: false }, ...patch })
  beforeEach(async () => {
    await mkdir(resolve('tmp'), { recursive: true })
    root = await mkdtemp(resolve('tmp/model-tiers-'))
    cwd = join(root, '.engram', 'work', 'bot-1')
    await mkdir(cwd, { recursive: true })
  })
  afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

  it('is on for Claude on macOS without any switch, and off elsewhere', () => {
    const platform = (value: string) => vi.stubGlobal('process', Object.create(process, { platform: { value } }))
    platform('darwin')
    expect([commandSandbox('claude'), commandSandbox('codex'), commandSandbox('mock')]).toEqual([true, true, false])
    vi.stubEnv('ENGRAM_CLAUDE_SANDBOX', '0')
    expect(commandSandbox('claude')).toBe(false)
    vi.stubEnv('ENGRAM_CLAUDE_SANDBOX', '')
    platform('win32')
    expect([commandSandbox('claude'), commandSandbox('codex')]).toEqual([false, true])
    expect(source('ipc.ts')).not.toMatch(/sandboxed: \w+\.id === 'codex'/)
  })

  it('runs sandboxed commands without a card and asks for every command that leaves the sandbox', async () => {
    const ask = vi.fn(async () => 'approve' as const)
    expect((await nativeDecision(policy({ mode: 'auto', sandboxed: true, ask }), 'Bash', { command: 'ls' })).behavior).toBe('allow')
    expect(ask).not.toHaveBeenCalled()
    expect((await nativeDecision(policy({ mode: 'auto', sandboxed: true, ask }), 'Bash', { command: 'curl example.com', dangerouslyDisableSandbox: true })).behavior).toBe('allow')
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]![0].words).toBe('Run this command outside the sandbox?\ncurl example.com')
    const granted = policy({ mode: 'once', sandboxed: true, commands: { allowed: true }, ask: vi.fn(async () => 'deny' as const) })
    expect((await nativeDecision(granted, 'Bash', { command: 'curl example.com', dangerouslyDisableSandbox: true })).behavior).toBe('deny')
    expect(granted.ask).toHaveBeenCalledOnce()
    expect((await nativeDecision(policy({ mode: 'auto', sandboxed: true }), 'Bash', { command: 'rm -rf /', dangerouslyDisableSandbox: true })).behavior).toBe('deny')
  })

  it('confines the session: no network, private folder unreadable, writes only in the task folder', async () => {
    const paths = vaultPaths(root)
    const options = { paths, channel: 'bot-1', cwd: join(paths.cache, 'work', 'bot-1'), mode: 'auto' as const, onStep: () => undefined, audit: () => undefined }
    await mkdir(options.cwd, { recursive: true })
    const boxed = await cometNativeTools({ ...options, sandboxed: true }), open = await cometNativeTools({ ...options, sandboxed: false })
    expect(boxed.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: [], strictAllowlist: true }, filesystem: { denyRead: [paths.privateDir] } })
    expect((boxed.sandbox!['filesystem'] as { denyWrite: string[] }).denyWrite).not.toContain(boxed.cwd)
    expect('sandbox' in open).toBe(false)
    const job = (native: typeof boxed): ToolSessionJob => ({ system: 'Rules. Commands are not sandboxed: use only the files and network access needed for this request.', prompt: 'go', tools: [], workdir: WORKDIR, native })
    expect(signatureOf(job(boxed))).not.toBe(signatureOf(job(open)))
    expect(forSandbox(job(boxed)).system).toContain('Commands run in a sandbox with no network')
    expect(forSandbox(job(boxed)).system).not.toContain('not sandboxed')
    expect(forSandbox(job(open)).system).toContain('not sandboxed')
    expect(readFileSync(resolve(__dirname, '../../../packages/core/src/agent-session-shape.ts'), 'utf8')).toContain('Commands are not sandboxed: use only the files and network access needed for this request.')
    expect(source('engine-claude-session.ts')).toContain("'sandbox' in job.native ? { sandbox: job.native.sandbox }")
  })
})

describe('stack-5: low effort stays on the turns it was given to', () => {
  it('a team turn is low only for the weekly summary, a desk turn only for a pre-read note or a remember turn, and a desk kind is never a team or lookup turn', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain("...(company ? { modelHint: 'smart' as const, ...(summing ? { lookup: true } : {}) } : {}),")
    expect(ipc).toContain("...(desk ? { modelHint: 'smart' as const, ...(deskLight(kind, routed, { given: !!given, made: earlierOutputs.some(output => /\\.(pptx|docx|xlsx)$/i.test(output.name)) }) ? { light: true } : {}) } : {}),")
    expect(ipc).toContain('const kind = !company && !lane && deskLane(routed, plainAsk) ? deskKind(routed) : undefined')
    expect(ipc).not.toContain('koreanLead(')
    expect(ipc.slice(ipc.indexOf('await lookup.run('), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
    expect(FILE_JOB_RULE).toContain('ends with exactly ONE short offer line of something new that would really help')
  })
})
