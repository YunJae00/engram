import type { NativeDecision, NativeTools, ToolSessionJob, ToolSessionResult } from 'core'
import { DevRpc } from './dev-rpc.js'
import { flog } from './flog.js'

// ChatGPT with its own shell and patch tools, through the runtime's app
// server: every command it wants to run and every file it wants to change is
// put to Engram first, writes stay in the comet's task folder, and the
// network stays off inside the sandbox. Engram's own tools ride along on the
// loopback tool server.

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const DECISION_MS = 120_000

export interface CodexRpc {
  initialize(): Promise<void>
  send(method: string, params: Data, timeout?: number): Promise<Data>
  shutdown(): Promise<void>
}
export type CodexRpcFactory = (
  options: { cwd: string; env: NodeJS.ProcessEnv; config: string[] },
  notify: (method: string, params: Data) => void,
  request: (method: string, params: Data) => Promise<unknown>,
  ended: (error: Error) => void,
) => CodexRpc

export const appServer = (binary: string): CodexRpcFactory => (options, notify, request, ended) =>
  new DevRpc(binary, { cwd: options.cwd, env: options.env, config: options.config }, notify, request, ended)

export interface CodexNativeSpec {
  rpc: CodexRpcFactory
  env: NodeJS.ProcessEnv
  config: string[]
  instructions: string
  model?: string
  budgetMs: number
}

type NativeResult = ToolSessionResult & { commandsDenied?: true }

export function runCodexNative(job: ToolSessionJob & { native: NativeTools }, spec: CodexNativeSpec): Promise<NativeResult> {
  const native = job.native
  return new Promise<NativeResult>((resolve) => {
    let answer = '', settled = false, threadId = '', turnId = ''
    const recorded = new Set<string>()
    const controller = new AbortController()
    const finish = (result: NativeResult): void => {
      if (settled) return
      settled = true
      controller.abort()
      clearTimeout(budget)
      job.signal?.removeEventListener('abort', cancel)
      void rpc.shutdown().catch(() => undefined)
      resolve(result)
    }
    // One answer per call, bounded: a decision that does not come is a refusal.
    const decide = async (name: string, input: Data): Promise<NativeDecision> => {
      const call = new AbortController()
      const stop = () => call.abort()
      controller.signal.addEventListener('abort', stop, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const late = new Promise<NativeDecision>((done) => { timer = setTimeout(() => { call.abort(); done({ behavior: 'deny', message: 'No decision arrived in time.' }) }, DECISION_MS); timer.unref() })
        const result = await Promise.race([native.decide(name, input, call.signal), late])
        if (call.signal.aborted && result.behavior === 'allow') return { behavior: 'deny', message: 'The call was canceled.' }
        if (result.behavior === 'deny') flog('native-tools', `denied ${name}: ${result.message ?? ''}`)
        return result
      } catch { return { behavior: 'deny', message: 'The permission check failed.' } }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop) }
    }
    const notify = (method: string, params: Data): void => {
      if (settled || (params['threadId'] && params['threadId'] !== threadId)) return
      job.onProgress?.()
      if (method === 'item/agentMessage/delta') { job.onToken?.(text(params['delta'])); return }
      const item = object(params['item']), id = text(item['id']), type = text(item['type'])
      if (method === 'item/started') {
        // Words before an action were thinking aloud, not the reply.
        if (type && type !== 'agentMessage' && type !== 'userMessage' && type !== 'reasoning') job.onReset?.()
        if (type === 'commandExecution' || type === 'fileChange') {
          recorded.add(id)
          native.onCall?.(type === 'commandExecution' ? 'Bash' : 'Write', type === 'commandExecution' ? { command: text(item['command']) } : { file_path: (Array.isArray(item['changes']) ? item['changes'] : []).map(change => text(object(change)['path'])).join(', ') })
        }
        return
      }
      if (method === 'item/completed') {
        if (type === 'agentMessage') answer = text(item['text']) || answer
        if (type === 'commandExecution' || type === 'fileChange') {
          const name = type === 'commandExecution' ? 'Bash' : 'Write'
          if (!recorded.has(id)) native.onCall?.(name, type === 'commandExecution' ? { command: text(item['command']) } : { file_path: (Array.isArray(item['changes']) ? item['changes'] : []).map(change => text(object(change)['path'])).join(', ') })
          recorded.delete(id)
          native.onResult?.(name, text(item['status']) === 'completed' && (type !== 'commandExecution' || item['exitCode'] === 0))
        }
        return
      }
      if (method === 'turn/completed') {
        const turn = object(params['turn']), status = text(turn['status'])
        if (status === 'completed') finish({ answer })
        else finish({ answer, error: status === 'interrupted' ? 'canceled' : text(object(turn['error'])['message']) || 'The ChatGPT turn failed.' })
        return
      }
      if (method === 'error' && !params['willRetry']) finish({ answer, error: text(object(params['error'])['message']) || 'The ChatGPT runtime reported an error.' })
    }
    const request = async (method: string, params: Data): Promise<unknown> => {
      if (settled || params['threadId'] !== threadId) throw new Error('This request does not belong to the active turn.')
      // The host approves command use before starting; runtime approvals could bypass the sandbox.
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' }
      if (method === 'item/tool/requestUserInput') throw new Error('Ask with ask_person instead.')
      throw new Error('This permission request is not supported; nothing was granted.')
    }
    const rpc = spec.rpc({ cwd: native.cwd, env: spec.env, config: spec.config }, notify, request, (error) => finish({ answer, error: error.message }))
    const cancel = (): void => {
      if (threadId && turnId) void rpc.send('turn/interrupt', { threadId, turnId }, 5_000).catch(() => undefined)
      finish({ answer, error: 'canceled' })
    }
    const budget = setTimeout(() => finish({ answer, error: `timed out after ${spec.budgetMs}ms` }), spec.budgetMs)
    if (job.signal?.aborted) { cancel(); return }
    job.signal?.addEventListener('abort', cancel, { once: true })
    void (async () => {
      const decision = await decide('Bash', { command: 'Use sandboxed commands for this task' })
      if (settled) return
      if (decision.behavior !== 'allow') { finish({ answer, error: decision.message || 'Commands were not approved.', commandsDenied: true }); return }
      await rpc.initialize()
      const thread = await rpc.send('thread/start', {
        cwd: native.cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true,
        developerInstructions: spec.instructions, ...(spec.model ? { model: spec.model } : {}),
      })
      threadId = text(object(thread['thread'])['id'])
      if (!threadId) throw new Error('The ChatGPT runtime did not open a session.')
      const turn = await rpc.send('turn/start', {
        threadId, input: [{ type: 'text', text: [job.opening, job.prompt].filter(Boolean).join('\n\n'), text_elements: [] }],
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [native.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        ...(job.effort ? { effort: job.effort } : {}),
      })
      turnId = text(object(turn['turn'])['id'])
    })().catch((error: unknown) => finish({ answer, error: error instanceof Error ? error.message : String(error) }))
  })
}
