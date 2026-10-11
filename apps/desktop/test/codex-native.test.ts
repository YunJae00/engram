import { describe, expect, it, vi } from 'vitest'
import type { NativeTools, ToolSessionJob } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home' } }))
import { runCodexNative, type CodexRpcFactory } from '../src/main/codex-native.js'
import { NATIVE_TOOLS_OFF, RUNTIME_TOOLS_OFF } from '../src/main/engine-codex.js'

type Data = Record<string, unknown>
type Script = (server: { notify(method: string, params: Data): void; request(method: string, params: Data): Promise<unknown> }) => Promise<void>

// An app server played from a script: what the runtime would send, in order.
function fakeServer(script: Script, sent: { method: string; params: Data }[] = []): CodexRpcFactory {
  return (_options, notify, request) => ({
    initialize: async () => {},
    shutdown: async () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 't1' } }
      if (method === 'turn/start') {
        setTimeout(() => void script({ notify: (m, p) => notify(m, { threadId: 't1', turnId: 'u1', ...p }), request: (m, p) => request(m, { threadId: 't1', turnId: 'u1', ...p }) }), 0)
        return { turn: { id: 'u1' } }
      }
      return {}
    },
  })
}

function native(decide: NativeTools['decide']): NativeTools & { calls: string[]; results: string[] } {
  const calls: string[] = [], results: string[] = []
  return { cwd: 'C:/work/bot-1', readRoots: [], decide, calls, results, onCall: (name, input) => calls.push(`${name} ${String(input['command'] ?? input['file_path'])}`), onResult: (name, ok) => results.push(`${name} ${ok}`) }
}

const job = (hands: NativeTools): ToolSessionJob & { native: NativeTools } => ({ workdir: 'C:/vault' as ToolSessionJob['workdir'], system: 'system', prompt: 'Sum the column', tools: [], maxCalls: 10, native: hands })
const spec = (rpc: CodexRpcFactory) => ({ rpc, env: {}, config: [], instructions: 'rules', budgetMs: 5_000 })
const completed = (item: Data) => ['item/completed', { item }] as const

describe('ChatGPT with its own tools', () => {
  it('gets host consent before starting, refuses sandbox elevation and returns the final message', async () => {
    const answers: unknown[] = [], sent: { method: string; params: Data }[] = []
    const hands = native(async (name) => ({ behavior: name === 'Bash' ? 'allow' : 'deny' }))
    const result = await runCodexNative(job(hands), spec(fakeServer(async (server) => {
      server.notify('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'python sum.py' } })
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c1', command: 'python sum.py' }))
      server.notify(...completed({ id: 'c1', type: 'commandExecution', command: 'python sum.py', status: 'completed', exitCode: 0 }))
      server.notify(...completed({ id: 'm1', type: 'agentMessage', text: '42' }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    }, sent)))
    expect(result).toEqual({ answer: '42' })
    expect(answers).toEqual([{ decision: 'decline' }])
    expect(hands.calls).toEqual(['Bash python sum.py'])
    expect(hands.results).toEqual(['Bash true'])
    const thread = sent.find(one => one.method === 'thread/start')!.params, turn = sent.find(one => one.method === 'turn/start')!.params
    expect(thread).toMatchObject({ cwd: 'C:/work/bot-1', approvalPolicy: 'never', sandbox: 'workspace-write', developerInstructions: 'rules' })
    expect(turn['sandboxPolicy']).toEqual({ type: 'workspaceWrite', writableRoots: ['C:/work/bot-1'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
  })

  it('declines runtime elevation and records sandboxed command results', async () => {
    const answers: unknown[] = []
    const hands = native(async () => ({ behavior: 'allow' }))
    await runCodexNative(job(hands), spec(fakeServer(async (server) => {
      answers.push(await server.request('item/commandExecution/requestApproval', { itemId: 'c1', command: 'del report.xlsx' }))
      server.notify('item/started', { item: { id: 'f1', type: 'fileChange', changes: [{ path: 'C:/Users/me/Documents/x.md' }] } })
      answers.push(await server.request('item/fileChange/requestApproval', { itemId: 'f1' }))
      answers.push(await server.request('item/fileChange/requestApproval', { itemId: 'unknown' }))
      server.notify(...completed({ id: 'f1', type: 'fileChange', changes: [{ path: 'C:/Users/me/Documents/x.md' }], status: 'failed' }))
      server.notify(...completed({ id: 'c2', type: 'commandExecution', command: 'dir', status: 'completed', exitCode: 0 }))
      server.notify('turn/completed', { turn: { status: 'completed' } })
    })))
    expect(answers).toEqual([{ decision: 'decline' }, { decision: 'decline' }, { decision: 'decline' }])
    expect(hands.calls).toEqual(['Write C:/Users/me/Documents/x.md', 'Bash dir'])
    expect(hands.results).toEqual(['Write false', 'Bash true'])
  })

  it('never starts the runtime turn without host consent', async () => {
    const sent: { method: string; params: Data }[] = []
    const hands = native(async () => ({ behavior: 'deny', message: 'The person declined.' }))
    const result = await runCodexNative(job(hands), spec(fakeServer(async () => {}, sent)))
    expect(result.error).toBe('The person declined.')
    expect(sent).toEqual([])
    expect(hands.calls).toEqual([])
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

  it('ends a turn that runs past its budget or is canceled', async () => {
    const hands = native(async () => ({ behavior: 'allow' }))
    const slow = await runCodexNative(job(hands), { ...spec(fakeServer(async () => {})), budgetMs: 30 })
    expect(slow.error).toBe('timed out after 30ms')
    const abort = new AbortController()
    const pending = runCodexNative({ ...job(hands), signal: abort.signal }, spec(fakeServer(async () => {})))
    abort.abort()
    expect((await pending).error).toBe('canceled')
  })

  it('keeps the shell and file edits on and everything else that acts on its own off', () => {
    expect(RUNTIME_TOOLS_OFF).toContain('features.shell_tool=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('features.shell_tool=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('features.unified_exec=false')
    expect(NATIVE_TOOLS_OFF).not.toContain('include_apply_patch_tool=false')
    for (const kept of ['features.browser_use=false', 'features.computer_use=false', 'features.hooks=false', 'features.view_image=false', 'web_search="disabled"']) expect(NATIVE_TOOLS_OFF).toContain(kept)
  })
})
