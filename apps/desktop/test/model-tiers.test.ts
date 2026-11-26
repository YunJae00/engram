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
  VoiceSession: class { closed = false; spent = false; ready = true; ask = async () => 'fixture line'; close(): void { this.closed = true } },
}))
vi.mock('../src/main/setup-connection.js', () => ({ verifySetupConnection: async () => undefined }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), createEngine: (id: string) => {
  fixture.created.push(id)
  return { id, detect: async () => ({ installed: true, loggedIn: true }), async *run() { yield { type: 'result', text: 'OK' } } }
} }))

import { chosenModel, forSandbox, tierPurpose, trimWarm } from '../src/main/engine-claude.js'
import { claudeEngine, claudeInputs, closeClaudeSessions } from '../src/main/engine-cloud.js'
import { SessionPool, signatureOf } from '../src/main/engine-claude-session.js'
import { beginFirstLine, cleanLine, endFirstLine, FIRST_LINE_BUDGET_MS, FIRST_LINE_FALLBACK_MS, firstLineCarried, firstLinePrompt, firstLineNote, firstLineReady, firstLineSaw, firstLineSpoke, SAFETY_LINE, wantsFirstLine, warmFirstLine, type FirstLineAsk } from '../src/main/first-line.js'
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
    const engine = claudeEngine('system')
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
    trimWarm(claudeInputs)
    expect(trim).toHaveBeenLastCalledWith(workerPool.target + 1)
    await claudeEngine('system').quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })
    trimWarm(claudeInputs)
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

  it('makes one quick call per turn, with the one first-line prompt, whatever the message is', async () => {
    for (const message of ['오늘 저녁 메뉴 셋만 골라줘', '반가워요, 오늘도 잘 부탁해요', '빛의 속도는 초속 몇 km야?', '나 다음 달에 이사 가']) {
      endFirstLine('bot-1')
      const live = voice(later('NONE', 300))
      begin(live, { message })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(300)
      expect(live.quick, message).toHaveBeenCalledOnce()
      expect(live.quick.mock.calls[0]![0], message).toBe(firstLinePrompt(message, true))
    }
  })

  it('posts a line that ends like the earlier ones, or names no split on a split ask, exactly as written', async () => {
    const said = async () => ['가계부부터 열어 볼게요.', '영수증부터 모아 볼게요.']
    let show = vi.fn()
    let quick = vi.fn(later('통장 내역부터 모아 볼게요.', 200))
    beginFirstLine({ ...ask({ message: '이번 달 카드값 얼마 나왔는지 정리해줘' }), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show, said })
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith('통장 내역부터 모아 볼게요.')
    expect(quick.mock.calls[0]![0]).toBe(firstLinePrompt('이번 달 카드값 얼마 나왔는지 정리해줘', true, await said()))
    endFirstLine('bot-1')
    show = vi.fn()
    quick = vi.fn(later('후보지 목록부터 뽑을게요.', 200))
    beginFirstLine({ ...ask({ message: '캠핑장 네 곳 후기는 한 곳씩 나눠서 검색시켜' }), engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: WORKDIR, signal: new AbortController().signal, show })
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith('후보지 목록부터 뽑을게요.')
  })

  it('shows the voice its earlier lines and asks for nothing on a greeting, a thanks, a telling or a one-step question', () => {
    const prompt = firstLinePrompt('이 사진 배경 지워줄 수 있어?', true, ['파일부터 열어 볼게요.'])
    expect(prompt).toContain('Your first lines earlier in this conversation: "파일부터 열어 볼게요."')
    expect(prompt).toContain('Reply with exactly NONE when the message is a greeting, a thanks, something the person only tells you that asks for nothing, or a question the assistant answers in one reply from what it already knows')
    expect(prompt).toContain('A question that needs anything looked up, read or done, a short ask that leaves its verb out, or an unclear request gets its first step like any other request.')
    expect(firstLinePrompt('x', true)).not.toContain('Your first lines earlier')
  })

  it('never holds the main turn: the note is read without waiting and the turn races the line', () => {
    const ipc = source('ipc.ts'), turn = source('answer.ts')
    expect(ipc).not.toMatch(/beginFirstLine|firstLineNote|await firstLine/)
    expect(turn).toContain('const note = firstLineNote(channel)')
    expect(turn).not.toMatch(/await firstLine/)
    expect(turn).toContain("const notes = [context?.(), calendarLine(), note].filter(Boolean).join('\\n\\n')")
    expect(turn).toContain('const hold = !!firstLineNote(channel)')
    expect(turn.indexOf('beginFirstLine({')).toBeLessThan(turn.indexOf('runComet('))
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
    begin(voice(later('x', 10)), { followUp: true })
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
    expect(ipc).toContain("show: line => broadcast({ type: 'chat:token', channel, text: `${line}\\n\\n` }), hide: () => broadcast({ type: 'chat:token', channel, text: '', reset: true, drop: true }) } }) : undefined")
    expect(ipc.indexOf('recordedRequests.add(request)')).toBeLessThan(ipc.indexOf('await begun!.run({'))
    const turn = source('answer.ts')
    expect(turn.indexOf('firstLineReady(channel)')).toBeGreaterThan(turn.indexOf('beginFirstLine({'))
    expect(turn.indexOf('firstLineReady(channel)')).toBeLessThan(turn.indexOf('const note = firstLineNote(channel)'))
    expect(ipc).toContain('extractChatCaptures(finishProgress(channel, rawText))')
    expect(ipc).not.toContain('withFirstLine')
    expect(ipc).toContain('tapBroadcast(firstLineSaw)')
  })

  it('puts the one safety line up at 1.3 s only when the voice has not spoken by then, and never over a line or a NONE that came first', async () => {
    const start = (engine: unknown, patch: Partial<FirstLineAsk> = {}) => {
      endFirstLine('bot-1')
      const show = vi.fn()
      beginFirstLine({ ...ask(patch), engine: async () => engine as never, workdir: WORKDIR, signal: new AbortController().signal, show })
      firstLineReady('bot-1')
      return show
    }
    let show = start(voice(later('회의록부터 읽어볼게요.', 1400)), { message: 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘' })
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS - 1)
    expect(show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
    expect(firstLineNote('bot-1')).toContain(SAFETY_LINE.ko)
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).toHaveBeenCalledOnce()
    expect(FIRST_LINE_FALLBACK_MS).toBe(1300)
    show = start(voice(async () => { throw new Error('voice down') }), { message: 'Who do I work with?', korean: false })
    await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.en)
    show = start(voice(later('회의록부터 읽어볼게요.', 900)))
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).toHaveBeenCalledExactlyOnceWith('회의록부터 읽어볼게요.')
    for (const message of ['거실 조명 색 온도 비교해서 하나 골라줘', '점심 맛있게 드세요', '1미터는 몇 센티야?']) {
      for (const reply of ['NONE', '']) {
        show = start(voice(later(reply, 600)), { message })
        await vi.advanceTimersByTimeAsync(600)
        expect(show, message).not.toHaveBeenCalled()
        expect(firstLineNote('bot-1')).toBe('')
        firstLineSpoke('bot-1')
        await vi.advanceTimersByTimeAsync(3000)
        expect(show, message).not.toHaveBeenCalled()
        show = start(voice(later(reply, 600)), { message })
        await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
        expect(show, message).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
      }
    }
    show = start(voice(later('NONE', 600)))
    firstLineSpoke('bot-1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).not.toHaveBeenCalled()
    expect(source('first-line.ts')).not.toMatch(/fallbackLine|STEPS|LANE_KO|READ_FIRST/)
    expect(source('answer.ts')).not.toMatch(/fallback/)
  })

  it('puts the safety line up for a line that misses 1.3 s, and the late line is never shown', async () => {
    const { show } = begin(voice(later('늦은 줄입니다.', 2000)))
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(FIRST_LINE_BUDGET_MS)
    expect(show).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).toHaveBeenCalledOnce()
  })

  it('drops the line when the answer speaks first', async () => {
    const { show } = begin(voice(later('보고서를 정리해드릴게요.', 300)))
    firstLineSpoke('bot-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
  })

  it('the team turn gets its first line from the same one call, and the host writes no team answer', () => {
    expect(source('answer.ts')).not.toMatch(/firstLineNow|laneLine|smallTalkAnswer/)
    expect(source('ipc.ts')).not.toMatch(/\bnow: !!company/)
    expect(source('ipc.ts')).not.toMatch(/\b(handoff|hire|split|change|direct|handed|summing) = /)
    expect(source('answer.ts')).toMatch(/const host: AgentLoopResult \| undefined = fixed \? /)
    expect(source('ipc.ts')).toMatch(/const reporting = company && turn\?\.report \? \(await listTasks\(paths\)\)\.find\(task => task\.state === 'running' && task\.botId === bot\.id\) : undefined\n[^\n]*const handedBack = employeesAnswer\(reporting\)/)
    expect(source('ipc.ts')).toContain('handedBack ? `${HANDED_BACK}\\n${handedBack}` : \'\'')
    expect(source('ipc.ts')).not.toMatch(/lastTeamResult|REPORT_WRITER_MS/)
    expect(source('ipc.ts').slice(source('ipc.ts').indexOf('await begun!.run({'), source('ipc.ts').indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  })

  it('only a steer the host applies itself is decided before the first line and shows none; a team question is no host answer', async () => {
    const ask = { channel: 'bot-1', message: '지우 무슨 일 하는 사람이야?', korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false }
    expect(wantsFirstLine(ask)).toBeNull()
    expect(wantsFirstLine({ ...ask, host: true })).toBe('host')
    vi.useFakeTimers()
    try {
      const show = vi.fn(), quick = vi.fn(async () => '지금 확인해 볼게요.')
      beginFirstLine({ ...ask, host: true, engine: async () => ({ id: 'claude', quick }), workdir: '/tmp' as never, signal: new AbortController().signal, show })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS + 1000)
      expect(show).not.toHaveBeenCalled()
      expect(quick).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    } finally { vi.useRealTimers(); endFirstLine('bot-1') }
    const ipc = source('ipc.ts'), decided = ipc.indexOf('const steer = bot?.primary && '), begun = ipc.indexOf('ack: { host: !!steer,')
    expect(decided).toBeGreaterThan(0)
    expect(begun).toBeGreaterThan(decided)
    const line = ipc.slice(decided, ipc.indexOf('\n', decided))
    expect(line).toMatch(/steerShaped\(request\.message\) \? plainSteer\(request\.message, await listTasks\(paths\), bot\.id\) : undefined$/)
    expect(line).not.toMatch(/answersItself|isStatusAsk|isDutyCancel|takesCompanyLane|lastReplyOf/)
  })

  it('says nothing where no first line is wanted: a report turn, a follow-up, a secret, a stopped turn', async () => {
    for (const patch of [{ interactive: false }, { followUp: true }, { secret: true }] as Partial<FirstLineAsk>[]) {
      const { show } = begin(voice(async () => 'x'), patch)
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(2000)
      expect(show, JSON.stringify(patch)).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
    }
    const abort = new AbortController()
    const { show } = begin(voice(later('x', 300)), {}, abort.signal)
    firstLineReady('bot-1')
    abort.abort()
    await vi.advanceTimersByTimeAsync(2000)
    expect(show).not.toHaveBeenCalled()
  })

  it('a team status question gets its first line like any other team ask: nothing in the first line reads it as status', async () => {
    for (const message of ['다들 뭐해', '팀 현황', '에이전트 현황 보여줘', 'status']) {
      expect(wantsFirstLine(ask({ message })), message).toBeNull()
      const live = voice(async () => '다들 하는 일 볼게요.')
      const { show } = begin(live, { message })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(2000)
      expect(live.quick, message).toHaveBeenCalled()
      expect(show, message).toHaveBeenCalledOnce()
      endFirstLine('bot-1')
    }
    expect(source('first-line.ts')).not.toMatch(/isStatusAsk|'status'/)
  })

  it('skips ineligible turns without resolving the engine, and leaves every short or chatty message to the voice', async () => {
    const skipped: Partial<FirstLineAsk>[] = [{ studying: true }, { limited: true }, { followUp: true }, { interactive: false }, { secret: true }, { message: '/tidy the inbox now please' }, { channel: 'panel' }, { channel: 'new-comet' }]
    for (const patch of skipped) {
      expect(wantsFirstLine(ask(patch)), JSON.stringify(patch)).not.toBeNull()
      const live = voice(async () => '줄')
      const { show, getter } = begin(live, patch)
      await vi.advanceTimersByTimeAsync(2000)
      expect(getter).not.toHaveBeenCalled()
      expect(live.quick).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
    }
    for (const message of ['ㅇㅇ', '👍', 'ok', '좋아요', '메일 써줘', 'What is 2+2?', '고마워, 이제 계약서 요약해줘', '안녕하세요!']) expect(wantsFirstLine(ask({ message, korean: false })), message).toBeNull()
    expect(source('first-line.ts')).not.toMatch(/chit-chat|SMALL_TALK|GREETING|SMALL_TAIL/)
  })

  it('a greeting or a thanks the voice answers NONE to gets no line of its own and no note, so an answer by 1.3 s is the first text, and only a silent screen gets the safety line', async () => {
    for (const message of ['좋은 저녁이에요, 내일도 부탁해요', '도와줘서 진짜 고마웠어요', 'Have a nice weekend!']) {
      endFirstLine('bot-1')
      const live = voice(later('NONE', 500))
      const { show } = begin(live, { message })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(500)
      expect(live.quick).toHaveBeenCalledOnce()
      expect(show, message).not.toHaveBeenCalled()
      expect(firstLineNote('bot-1')).toBe('')
      expect(firstLineCarried('bot-1')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(FIRST_LINE_FALLBACK_MS)
      expect(show, message).toHaveBeenCalledExactlyOnceWith(SAFETY_LINE.ko)
    }
    expect(FIRST_LINE_BUDGET_MS).toBeLessThan(2000)
  })

  it('stays silent for mock or missing engines', async () => {
    for (const engine of [undefined, { id: 'mock' }, { id: 'mock', quick: async () => '줄' }]) {
      const { show } = begin(engine)
      firstLineReady('bot-1')
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
    const engine = claudeEngine('profile-late')
    const voiceOf = (): Promise<{ closed: boolean; ready: boolean; ask(): Promise<string> }> => (engine as unknown as { voiceFor(w: string): Promise<never> }).voiceFor(WORKDIR)
    const stuck = await voiceOf()
    stuck.ask = async () => { stuck.ready = false; throw new Error('The voice took too long.') }
    await expect(engine.quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })).rejects.toThrow('too long')
    expect(stuck.closed).toBe(true)
    const fresh = await voiceOf()
    expect(fresh).not.toBe(stuck)
    expect(await engine.quick('say it', { workdir: WORKDIR, timeoutMs: 1000 })).toBe('fixture line')
  })

  it('opens a fresh voice ahead once one has answered, so no quick call reads an earlier one', async () => {
    const engine = claudeEngine('profile-once')
    const voiceOf = (): Promise<{ closed: boolean; spent: boolean; ask(): Promise<string> }> => (engine as unknown as { voiceFor(w: string): Promise<never> }).voiceFor(WORKDIR)
    const used = await voiceOf()
    used.ask = async () => { used.spent = true; return '빵집 영업시간부터 볼게요.' }
    expect(await engine.quick('동네 빵집 영업시간 정리해줘', { workdir: WORKDIR, timeoutMs: 1000 })).toBe('빵집 영업시간부터 볼게요.')
    await vi.waitFor(() => expect(used.closed).toBe(true))
    const next = await voiceOf()
    expect(next).not.toBe(used)
    expect(next.closed).toBe(false)
  })

  it('opens two quick voices ahead, so a turn\'s two quick calls both land on a warm one', async () => {
    const engine = claudeEngine('profile-two')
    const lane = (one: number): Promise<{ closed: boolean }> => (engine as unknown as { voiceFor(w: string, l: number): Promise<never> }).voiceFor(WORKDIR, one)
    const trim = vi.spyOn(SessionPool.prototype, 'trim')
    await engine.warmQuick(WORKDIR)
    trimWarm(claudeInputs)
    expect(trim).toHaveBeenLastCalledWith(workerPool.target + 1 - 2)
    const second = await lane(1)
    expect(second.closed).toBe(false)
    expect(await lane(1)).toBe(second)
  })

  it('gives a turn\'s two quick calls a voice each even when memory is short', async () => {
    const engine = claudeEngine('profile-short')
    const lane = (one: number): Promise<{ ask(): Promise<string> }> => (engine as unknown as { voiceFor(w: string, l: number): Promise<never> }).voiceFor(WORKDIR, one)
    const target = workerPool.target
    workerPool.target = 1
    try {
      await engine.warmQuick(WORKDIR)
      const asked: number[] = []
      for (const one of [0, 1]) (await lane(one)).ask = async () => { asked.push(one); return `lane ${one}` }
      const answers = await Promise.all(['수영장 운영 시간 알려줘', '수영장 근처 주차장도'].map(prompt => engine.quick(prompt, { workdir: WORKDIR, timeoutMs: 1000 })))
      expect(new Set(answers)).toEqual(new Set(['lane 0', 'lane 1']))
      expect(asked.sort()).toEqual([0, 1])
    } finally { workerPool.target = target }
  })

  it('keeps one voice per Claude account, so a switch never answers from the old one', async () => {
    const opened: unknown[] = []
    const a = claudeEngine('profile-a'), b = claudeEngine('profile-b')
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
  it('a team turn is low unless it writes a result from hand-backs, and no desk turn sets its own model or effort', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain("...(company ? { modelHint: 'smart' as const, ...(turn?.report ? {} : { light: true }) } : {}),")
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/modelHint|light: true|deskKind|deskLane/)
    expect(ipc).not.toContain('koreanLead(')
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
    expect(FILE_JOB_RULE).toContain('ends with exactly ONE short offer line of something new that would really help')
  })
})

describe('s1a: the team lane\'s model does the team\'s work', () => {
  const ipc = source('ipc.ts')
  const chat = ipc.slice(ipc.indexOf('async function handleChatSend('), ipc.indexOf('answerDelivered = true'))
  const imported = ipc.slice(0, ipc.indexOf('\nconst '))
  it('the host runs no team tool and writes no team answer from a chat message', () => {
    expect(chat.length).toBeGreaterThan(1000)
    for (const host of [/tool\.name === direct\.tool/, /const (direct|handed|summing) =/, /companyStatus\(/, /dutyList\(/, /teamSummary\(/, /aboutEmployee\(/, /removeScheduled\(/]) expect(chat, String(host)).not.toMatch(host)
    for (const name of ['answersItself', 'plainHandoff', 'plainSplit', 'plainChange', 'plainHire', 'aboutEmployee', 'dutyList', 'dutyToCancel', 'isDutyListAsk', 'isStatusAsk', 'teamSummary', 'plainSchedule', 'SUMMARY_WRITER_MS', 'companyStatus,']) expect(imported, name).not.toContain(name)
    expect(ipc.match(/removeScheduled\(/g)).toEqual(['removeScheduled('])
    expect(ipc).toContain('remove: (id) => removeScheduled(paths, id),')
  })
  it('a team turn reaches the lane with the kept schedules and the last reply, and its tools are the lane menu', () => {
    expect(chat).toContain("takesCompanyLane(request.message, { staff: staff.map(one => one.name), gone: employees(await loadArchivedBots(paths)).map(one => one.name), chief, scheduled: request.scheduled === true, kept: everyone.flatMap(one => one.tasks ?? []), lastReply: lastReplyOf(savedHistory) })")
    expect(chat).toContain('.filter(tool => !company || COMPANY_LANE_TOOLS.has(tool.name))')
  })
  it('effort is set by lane: a team turn that is not a report turn is low effort on the smart tier, whatever it says; the report turn keeps its options and every other turn gets no model hint or effort of its own', () => {
    const team = "...(company ? { modelHint: 'smart' as const, ...(turn?.report ? {} : { light: true }) } : {}),"
    expect(chat).toContain(team)
    expect(team).not.toMatch(/request|message|routed|ask/)
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/modelHint|light: true|deskKind|deskLane/)
    expect(chat).toContain("const company = !guided && !recovery && !savedRoutine && !turn?.verification && !attachments.paths.length && !studying.has(channel) && (chief || !bot.label)\n        && (turn?.report === true || takesCompanyLane(")
  })
})
