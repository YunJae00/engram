import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultPaths, type EngineCwd, type ToolSessionJob } from 'core'

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
import { beginFirstLine, cleanLine, endFirstLine, FIRST_LINE_BUDGET_MS, firstLineCarried, firstLineNote, firstLineReady, firstLineSaw, firstLineSpoke, wantsFirstLine, warmFirstLine, withFirstLine, type FirstLineAsk } from '../src/main/first-line.js'
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
    expect(chosenModel()).toBe('claude-opus-5-5')
    expect(chosenModel('default')).toBe('claude-opus-5-5')
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
    expect(source('engine-claude.ts')).toContain("tier('work', chosenModel())")
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

  it('never holds the main turn: the note is read without waiting and the turn races the line', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const firstSaid = firstLineNote(channel)')
    expect(ipc).not.toMatch(/await firstLine/)
    expect(ipc).toMatch(/attachmentContext: \[[^\n]*firstSaid\]/)
    expect(ipc).toContain('onToken: (text) => { firstLineSpoke(channel);')
    expect(ipc.indexOf('beginFirstLine({')).toBeLessThan(ipc.indexOf('handleChatSend(request, controller.signal'))
  })

  it('holds a line that comes before the request is saved, and shows it right after', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 100)))
    await vi.advanceTimersByTimeAsync(100)
    expect(show).not.toHaveBeenCalled()
    firstLineReady('bot-1')
    expect(show).toHaveBeenCalledExactlyOnceWith('보고서를 표로 정리해드릴게요.')
    expect(firstLineNote('bot-1')).toContain('보고서를 표로 정리해드릴게요.')
  })

  it('never shows a line that arrives after the main prompt was built, so the prompt is exact', async () => {
    const { show } = begin(voice(later('보고서를 표로 정리해드릴게요.', 300)))
    firstLineReady('bot-1')
    expect(firstLineNote('bot-1')).toBe('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(show).not.toHaveBeenCalled()
    expect(firstLineNote('bot-1')).toBe('')
  })

  it('keeps the shown line as the start of the answer until a reset finalizes it', async () => {
    begin(voice(later('보고서를 정리해드릴게요.', 10)))
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(firstLineCarried('bot-1')).toBe('보고서를 정리해드릴게요.')
    expect(withFirstLine('bot-1', '| 분기 | 매출 |')).toBe('보고서를 정리해드릴게요.\n\n| 분기 | 매출 |')
    expect(withFirstLine('bot-1', '보고서를 정리해드릴게요.\n\n표')).toBe('보고서를 정리해드릴게요.\n\n표')
    firstLineSaw({ type: 'chat:token', channel: 'bot-2', text: '', reset: true })
    expect(firstLineCarried('bot-1')).toBe('보고서를 정리해드릴게요.')
    firstLineSaw({ type: 'chat:token', channel: 'bot-1', text: '', reset: true })
    expect(firstLineCarried('bot-1')).toBeUndefined()
    expect(withFirstLine('bot-1', '표')).toBe('표')
  })

  it('wires the line into the answer stream after the saved request, with no reset of its own', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain("show: line => broadcast({ type: 'chat:token', channel: entry.channel, text: `${line}\\n\\n` }) })")
    expect(ipc.indexOf('recordedRequests.add(request)')).toBeLessThan(ipc.indexOf('firstLineReady(channel)'))
    expect(ipc.indexOf('firstLineReady(channel)')).toBeLessThan(ipc.indexOf('const firstSaid = firstLineNote(channel)'))
    expect(ipc).toContain('extractChatCaptures(finishProgress(channel, withFirstLine(channel, rawText)))')
    expect(ipc).toContain('tapBroadcast(firstLineSaw)')
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

  it('skips chit-chat, one-line questions and ineligible turns without resolving the engine', async () => {
    const skipped: Partial<FirstLineAsk>[] = [
      { message: '안녕' }, { message: 'thanks!' }, { message: 'Thanks for your help' }, { message: '고마워요 잘 됐어요' }, { message: 'How are you?' }, { message: "what's up" }, { message: '잘 지냈어요?' }, { message: 'how are you doing today?' },
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
    // A short question can be a job; the small model answers NONE when one sentence settles it.
    for (const message of ['Can you draft the Q3 report?', 'ok, draft the report', 'What is 2+2?', '고마워, 이제 계약서 요약해줘']) expect(wantsFirstLine(ask({ message, korean: false })), message).toBeNull()
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
