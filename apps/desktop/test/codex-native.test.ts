import { describe, expect, it, vi } from 'vitest'
import type { NativeTools, ToolSessionJob } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home' } }))
import { claimCodexWorkFolder, closeCodexSessions, runCodexNative, warmCodexSession, type CodexRpcFactory } from '../src/main/codex-native.js'
import { NATIVE_TOOLS_OFF, RUNTIME_TOOLS_OFF } from '../src/main/engine-codex.js'

type Data = Record<string, unknown>
type Script = (server: { notify(method: string, params: Data): void; request(method: string, params: Data): Promise<unknown> }) => Promise<void>

// An app server played from a script: what the runtime would send, in order.
function fakeServer(script: Script, sent: { method: string; params: Data }[] = []): CodexRpcFactory {
  return (_options, notify, request) => {
    let turns = 0
    return {
    initialize: async () => {},
    shutdown: async () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 't1' } }
      if (method === 'turn/start') {
        const turnId = `u${++turns}`
        setTimeout(() => void script({ notify: (m, p) => notify(m, { threadId: 't1', turnId, ...p }), request: (m, p) => request(m, { threadId: 't1', turnId, ...p }) }), 0)
        return { turn: { id: turnId } }
      }
      return {}
    },
    }
  }
}

function native(decide: NativeTools['decide']): NativeTools & { calls: string[]; results: string[] } {
  const calls: string[] = [], results: string[] = []
  return { cwd: 'C:/work/bot-1', readRoots: [], decide, calls, results, onCall: (name, input) => calls.push(`${name} ${String(input['command'] ?? input['file_path'])}`), onResult: (name, ok) => results.push(`${name} ${ok}`) }
}

const job = (hands: NativeTools): ToolSessionJob & { native: NativeTools } => ({ workdir: 'C:/vault' as ToolSessionJob['workdir'], system: 'system', prompt: 'Sum the column', tools: [], maxCalls: 10, native: hands })
const spec = (rpc: CodexRpcFactory) => ({ rpc, env: {}, config: [], instructions: 'rules' })
const completed = (item: Data) => ['item/completed', { item }] as const

describe('ChatGPT with its own tools', () => {
  it('asks nothing before a command is wanted and answers a turn that needs none', async () => {
    const sent: { method: string; params: Data }[] = []
    const decide = vi.fn<NativeTools['decide']>(async () => ({ behavior: 'allow' }))
    const result = await runCodexNative(job(native(decide)), spec(fakeServer(async (server) => {
      server.notify(...completed({ id: 'm1', type: 'agentMessage', text: '28 hours' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    }, sent)))
    expect(result).toEqual({ answer: '28 hours' })
    expect(decide).not.toHaveBeenCalled()
    const thread = sent.find(one => one.method === 'thread/start')!.params, turn = sent.find(one => one.method === 'turn/start')!.params
    expect(thread).toMatchObject({ cwd: 'C:/work/bot-1', approvalPolicy: 'untrusted', sandbox: 'workspace-write', developerInstructions: 'rules' })
    expect(turn).toMatchObject({ approvalPolicy: 'untrusted' })
    expect(turn['sandboxPolicy']).toEqual({ type: 'workspaceWrite', writableRoots: ['C:/work/bot-1'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
  })

  it('puts words sent mid-turn into that turn as the person own message, and stops offering once it ends', async () => {
    const sent: { method: string; params: Data }[] = []
    let steer: ((said: string[]) => Promise<boolean>) | null = null
    const offered: (typeof steer)[] = []
    let taken = false
    const result = await runCodexNative({ ...job(native(async () => ({ behavior: 'allow' }))), onSteerable: (one) => { steer = one; offered.push(one) } }, spec(fakeServer(async (server) => {
      taken = await steer!(['Only tomorrow'])
      server.notify(...completed({ id: 'm1', type: 'agentMessage', text: 'Tomorrow: clear' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    }, sent)))
    expect(result).toEqual({ answer: 'Tomorrow: clear' })
    expect(taken).toBe(true)
    expect(sent.find(one => one.method === 'turn/steer')!.params).toEqual({ threadId: 't1', expectedTurnId: 'u1', input: [{ type: 'text', text: 'Only tomorrow', text_elements: [] }] })
    expect(offered.at(-1)).toBeNull()
  })

  it('puts the first wanted command to the person, then restarts where approval is never widened', async () => {
    const answers: unknown[] = [], sent: { method: string; params: Data }[] = []
    const decide = vi.fn<NativeTools['decide']>(async () => ({ behavior: 'allow' }))
    let turns = 0
    const result = await runCodexNative(job(native(decide)), spec(fakeServer(async (server) => {
      if (++turns === 1) {
        answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c1', kind: 'command', command: 'powershell.exe -Command "python sum.py"', commandActions: [{ type: 'unknown', command: 'python sum.py' }] }))
        server.notify('turn/completed', { turn: { status: 'interrupted' } })
        return
      }
      server.notify(...completed({ id: 'c2', type: 'commandExecution', command: 'python sum.py', status: 'completed', exitCode: 0 }))
      server.notify(...completed({ id: 'm1', type: 'agentMessage', text: '42' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    }, sent)))
    expect(result).toEqual({ answer: '42' })
    expect(answers).toEqual([{ decision: 'decline' }])
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide.mock.calls[0]!.slice(0, 2)).toEqual(['Bash', { command: 'python sum.py' }])
    expect(sent.map(one => one.method)).toEqual(['thread/start', 'turn/start', 'turn/interrupt', 'turn/start'])
    expect(sent.filter(one => one.method === 'turn/start').map(one => one.params['approvalPolicy'])).toEqual(['untrusted', 'never'])
  })

  it('runs where approval is never asked once commands are already allowed', async () => {
    const sent: { method: string; params: Data }[] = []
    const hands = native(async () => ({ behavior: 'allow' }))
    hands.ready = () => true
    const answers: unknown[] = []
    await runCodexNative(job(hands), spec(fakeServer(async (server) => {
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c1', kind: 'command', command: 'python sum.py', reason: 'retry without sandbox?' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    }, sent)))
    expect(answers).toEqual([{ decision: 'decline' }])
    expect(sent.find(one => one.method === 'thread/start')!.params['approvalPolicy']).toBe('never')
  })

  it('asks once per turn: a refusal holds, escalations are never put to the person, and patches stay in the task folder', async () => {
    const answers: unknown[] = []
    const decide = vi.fn<NativeTools['decide']>(async (name, input) => ({ behavior: name === 'Write' && !String(input['file_path']).includes('Documents') ? 'allow' : 'deny' }))
    const hands = native(decide)
    await runCodexNative(job(hands), spec(fakeServer(async (server) => {
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c0', kind: 'command', command: 'curl x', networkApprovalContext: { host: 'x' } }))
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c1', kind: 'command', command: 'del report.xlsx' }))
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c2', kind: 'command', command: 'dir' }))
      server.notify('item/started', { item: { id: 'f1', type: 'fileChange', changes: [{ path: 'C:/work/bot-1/out.md' }] } })
      answers.push(await server.request('item/fileChange/requestApproval', { itemId: 'f1' }))
      server.notify('item/started', { item: { id: 'f2', type: 'fileChange', changes: [{ path: 'C:/Users/me/Documents/x.md' }] } })
      answers.push(await server.request('item/fileChange/requestApproval', { itemId: 'f2' }))
      answers.push(await server.request('item/fileChange/requestApproval', { itemId: 'unknown' }))
      server.notify(...completed({ id: 'f2', type: 'fileChange', changes: [{ path: 'C:/Users/me/Documents/x.md' }], status: 'failed' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    })))
    expect(answers).toEqual([{ decision: 'decline' }, { decision: 'decline' }, { decision: 'decline' }, { decision: 'accept' }, { decision: 'decline' }, { decision: 'decline' }])
    expect(decide.mock.calls.map(([name, input]) => `${name} ${String(input['command'] ?? input['file_path'])}`)).toEqual(['Bash del report.xlsx', 'Write C:/work/bot-1/out.md', 'Write C:/Users/me/Documents/x.md'])
    expect(hands.calls).toEqual(['Write C:/work/bot-1/out.md', 'Write C:/Users/me/Documents/x.md'])
    expect(hands.results).toEqual(['Write false'])
  })

  it('sends questions back to ask_person and reports a failed or interrupted turn', async () => {
    const hands = native(async () => ({ behavior: 'allow' }))
    let question: unknown
    const failed = await runCodexNative(job(hands), spec(fakeServer(async (server) => {
      question = await server.request('item/tool/requestUserInput', { itemId: 'q1' }).catch((error: Error) => error.message)
      server.notify(...completed({ id: 'm1', type: 'agentMessage', text: 'partial' }))
      server.notify('turn/completed', { turn: { status: 'failed', error: { message: 'usage limit' } } })
    })))
    expect(question).toBe('Ask with ask_person instead.')
    expect(failed).toEqual({ answer: 'partial', error: 'usage limit' })
  })

  it('ends a canceled turn', async () => {
    const hands = native(async () => ({ behavior: 'allow' }))
    const abort = new AbortController()
    const pending = runCodexNative({ ...job(hands), signal: abort.signal }, spec(fakeServer(async () => {})))
    abort.abort()
    expect((await pending).error).toBe('canceled')
  })

  it('falls back to Engram tools instead of using approval that can bypass the sandbox', async () => {
    const sent: { method: string; params: Data }[] = []
    const decide = vi.fn(async () => ({ behavior: 'allow' as const }))
    const hands = native(decide)
    hands.mode = 'each'
    const result = await runCodexNative(job(hands), spec(fakeServer(async () => {}, sent)))
    expect(result.commandsDenied).toBe(true)
    expect(result.error).toContain('native commands are disabled')
    expect(sent).toEqual([])
    expect(decide).not.toHaveBeenCalled()
  })

  it('keeps the shell and file edits on and everything else that acts on its own off', () => {
    expect(RUNTIME_TOOLS_OFF).toContain('features.shell_tool=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('features.shell_tool=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('features.unified_exec=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('include_apply_patch_tool=false')
    for (const kept of ['features.browser_use=false', 'features.computer_use=false', 'features.hooks=false', 'features.view_image=false', 'web_search="disabled"']) expect(NATIVE_TOOLS_OFF).toContain(kept)
  })
})

describe('a comet keeps its ChatGPT runtime between turns', () => {
  it('ignores late replies from a previous turn and opens a fresh process for another account', async () => {
    let turns = 0, processes = 0
    const rpc: CodexRpcFactory = (options, notify, request, ended) => {
      processes++
      return fakeServer(async server => {
        if (++turns === 2) {
          server.notify('item/completed', { turnId: 'u1', item: { id: 'old', type: 'agentMessage', text: 'stale' } })
          server.notify('turn/completed', { turnId: 'u1', turn: { status: 'completed' } })
        }
        server.notify(...completed({ id: 'new', type: 'agentMessage', text: `answer ${turns}` }))
        server.notify('turn/completed', { turn: { status: 'completed' } })
      })(options, notify, request, ended)
    }
    const base = { ...job(native(async () => ({ behavior: 'allow' }))), sessionKey: 'late-turns' }
    try {
      expect((await runCodexNative(base, spec(rpc))).answer).toBe('answer 1')
      expect((await runCodexNative(base, spec(rpc))).answer).toBe('answer 2')
      expect(processes).toBe(1)
      await runCodexNative(base, { ...spec(rpc), env: { CODEX_HOME: 'another-profile' } })
      expect(processes).toBe(2)
    } finally { closeCodexSessions() }
  })
  it('reuses the process and thread, sends the conversation so far only once, and opens anew when the rules change', async () => {
    const sent: { method: string; params: Data }[] = []
    let processes = 0
    const rpc: CodexRpcFactory = (options, notify, request, ended) => {
      processes++
      const answer = `answer from process ${processes}`
      return fakeServer(async (server) => {
        server.notify(...completed({ id: 'm1', type: 'agentMessage', text: answer }))
        server.notify('turn/completed', { turn: { status: 'completed' } })
      }, sent)(options, notify, request, ended)
    }
    const hands = native(async () => ({ behavior: 'allow' }))
    const base = { ...job(hands), sessionKey: 'bot-7', opening: 'Earlier: hello' }
    try {
      expect((await runCodexNative(base, spec(rpc))).answer).toBe('answer from process 1')
      expect((await runCodexNative({ ...base, prompt: 'Next' }, spec(rpc))).answer).toBe('answer from process 1')
      expect(processes).toBe(1)
      expect(sent.filter(one => one.method === 'thread/start')).toHaveLength(1)
      expect(sent.filter(one => one.method === 'turn/start').map(one => (one.params['input'] as { text: string }[])[0]!.text)).toEqual(['Earlier: hello\n\nSum the column', 'Next'])
      expect((await runCodexNative({ ...base, prompt: 'Again' }, { ...spec(rpc), instructions: 'other rules' })).answer).toBe('answer from process 2')
      expect(processes).toBe(2)
      // A job with no session key gets a process of its own, closed after the turn.
      await runCodexNative(job(hands), spec(rpc))
      await runCodexNative(job(hands), spec(rpc))
      expect(processes).toBe(4)
    } finally { closeCodexSessions() }
  })
})

describe('a spare ChatGPT session for the next comet', () => {
  it('closes an expired spare before replacing it', async () => {
    const shutdown = vi.fn(async () => undefined)
    const rpc: CodexRpcFactory = (options, notify, request, ended) => ({ ...fakeServer(async () => undefined)(options, notify, request, ended), shutdown })
    const hands = { ...native(async () => ({ behavior: 'allow' })), cwd: 'C:/work/spare-old' }
    try {
      await warmCodexSession(spec(rpc), hands)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60_000)
      await warmCodexSession(spec(rpc), { ...hands, cwd: 'C:/work/spare-new' })
      expect(shutdown).toHaveBeenCalledOnce()
      expect(claimCodexWorkFolder('next', 'C:/work/next')).toBe('C:/work/spare-new')
    } finally { closeCodexSessions(); vi.restoreAllMocks() }
  })

  it('is opened ahead in a folder of its own, and the comet that takes the folder takes the session', async () => {
    const sent: { method: string; params: Data }[] = []
    let processes = 0
    const rpc: CodexRpcFactory = (options, notify, request, ended) => {
      processes++
      return fakeServer(async (server) => {
        server.notify(...completed({ id: 'm1', type: 'agentMessage', text: 'warm answer' }))
        server.notify('turn/completed', { turn: { status: 'completed' } })
      }, sent)(options, notify, request, ended)
    }
    const hands = native(async () => ({ behavior: 'allow' }))
    hands.cwd = 'C:/work/spare-1'
    try {
      await warmCodexSession(spec(rpc), hands)
      expect(processes).toBe(1)
      expect(sent.map(one => one.method)).toEqual(['thread/start'])
      expect(claimCodexWorkFolder('bot-9', 'C:/work/bot-9')).toBe('C:/work/spare-1')
      expect(claimCodexWorkFolder('bot-9', 'C:/work/bot-9')).toBe('C:/work/spare-1')
      expect(claimCodexWorkFolder('bot-10', 'C:/work/bot-10')).toBe('C:/work/bot-10')
      expect(claimCodexWorkFolder('bot-9', 'C:/other-vault/bot-9')).toBe('C:/other-vault/bot-9')
      const result = await runCodexNative({ ...job(hands), sessionKey: 'bot-9', opening: 'Earlier: hi' }, spec(rpc))
      expect(result.answer).toBe('warm answer')
      expect(processes).toBe(1)
      expect(sent.filter(one => one.method === 'thread/start')).toHaveLength(1)
      expect((sent.find(one => one.method === 'turn/start')!.params['input'] as { text: string }[])[0]!.text).toBe('Earlier: hi\n\nSum the column')
      // Taken: the next comet gets its own folder until another spare is warm.
      expect(claimCodexWorkFolder('bot-10', 'C:/work/bot-10')).toBe('C:/work/bot-10')
    } finally { closeCodexSessions() }
    expect(claimCodexWorkFolder('bot-9', 'C:/work/bot-9')).toBe('C:/work/bot-9')
  })
})

describe('a comet that takes a spare still starting', () => {
  it('keeps an opening spare owned during shutdown and never starts a turn after it closes', async () => {
    const sent: { method: string; params: Data }[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const shutdown = vi.fn(async () => undefined)
    const rpc: CodexRpcFactory = (options, notify, request, ended) => {
      const inner = fakeServer(async () => undefined, sent)(options, notify, request, ended)
      return { ...inner, shutdown, send: async (method, params) => { if (method === 'thread/start') await gate; return inner.send(method, params) } }
    }
    const hands = { ...native(async () => ({ behavior: 'allow' })), cwd: 'C:/work/spare-stop' }
    try {
      const warming = warmCodexSession(spec(rpc), hands)
      const turn = runCodexNative({ ...job(hands), sessionKey: 'stopping' }, spec(rpc))
      closeCodexSessions()
      expect(shutdown).toHaveBeenCalledOnce()
      release(); await warming
      expect((await turn).error).toContain('closed')
      expect(sent.some(one => one.method === 'turn/start')).toBe(false)
    } finally { release(); closeCodexSessions() }
  })

  it('waits for the thread to start rather than sending its turn to a thread that has none', async () => {
    const sent: { method: string; params: Data }[] = []
    let processes = 0, releaseStart: () => void = () => undefined
    const started = new Promise<void>(resolve => { releaseStart = resolve })
    const rpc: CodexRpcFactory = (options, notify, request, ended) => {
      processes++
      const inner = fakeServer(async (server) => {
        server.notify(...completed({ id: 'm1', type: 'agentMessage', text: 'warm answer' }))
        server.notify('turn/completed', { turn: { status: 'completed' } })
      }, sent)(options, notify, request, ended)
      return { ...inner, send: async (method, params) => { if (method !== 'thread/start') return inner.send(method, params); sent.push({ method, params }); await started; return { thread: { id: 't1' } } } }
    }
    const hands = native(async () => ({ behavior: 'allow' }))
    hands.cwd = 'C:/work/spare-2'
    try {
      const warming = warmCodexSession(spec(rpc), hands)
      expect(claimCodexWorkFolder('bot-11', 'C:/work/bot-11')).toBe('C:/work/spare-2')
      const turn = runCodexNative({ ...job(hands), sessionKey: 'bot-11' }, spec(rpc))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(sent.map(one => one.method)).toEqual(['thread/start'])
      releaseStart()
      await warming
      const result = await turn
      expect(result.answer).toBe('warm answer')
      expect(processes).toBe(1)
      expect(sent.map(one => one.method)).toEqual(['thread/start', 'turn/start'])
    } finally { closeCodexSessions() }
  })
})
