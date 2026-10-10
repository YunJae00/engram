import type { NativeDecision, NativeTools } from 'core'
import { TOOL_SERVER } from './engine-claude-tools.js'
import { flog } from './flog.js'

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const deny = (message: string): NativeDecision => ({ behavior: 'deny', message })
const DECISION_MS = 120_000

export function nativeOptions(current: () => NativeTools | undefined) {
  let owner: NativeTools | undefined
  const calls = new Map<string, { name: string; input: string; decision: Promise<NativeDecision> }>()
  const decide = (name: string, input: Data, id: string, signal: AbortSignal): Promise<NativeDecision> => {
    const native = current()
    if (owner !== native) { calls.clear(); owner = native }
    if (!native || signal.aborted) return Promise.resolve(deny('No active call is running.'))
    if (name.startsWith(`mcp__${TOOL_SERVER}__`)) return Promise.resolve({ behavior: 'allow' })
    const encoded = JSON.stringify(input)
    const open = id ? calls.get(id) : undefined
    if (open) return open.decision.then(result => open.name === name && (open.input === encoded || JSON.stringify(result.updatedInput) === encoded)
      ? result : deny('The tool call changed after its permission check.'))
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: () => void = () => {}
    const interrupted = new Promise<NativeDecision>(resolve => {
      cancel = () => { controller.abort(); resolve(deny('The call was canceled.')) }
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => { controller.abort(); resolve(deny('No decision arrived in time; continue without this call or report what remains.')) }, DECISION_MS)
      timer.unref()
    })
    const decision = (async (): Promise<NativeDecision> => {
      try {
        const result = await Promise.race([Promise.resolve().then(() => native.decide(name, input, controller.signal)), interrupted])
        if (controller.signal.aborted || current() !== native) return deny('The call was canceled or its turn ended.')
        if (result.behavior === 'allow') native.onCall?.(name, result.updatedInput ?? input)
        return result
      } catch { return deny('The tool permission check failed. Continue without this call.') }
      finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
    })().then(result => {
      if (result.behavior === 'deny') flog('native-tools', `denied ${name}: ${result.message ?? ''}`)
      return result
    })
    if (id) calls.set(id, { name, input: encoded, decision })
    return decision
  }
  const finished = (raw: Data, ok: boolean) => {
    const id = text(raw['tool_use_id']), call = calls.get(id)
    calls.delete(id)
    if (call && owner === current()) {
      try { owner?.onResult?.(call.name, ok) }
      catch { flog('native-tools', 'The native tool result could not be recorded.') }
    }
    return {}
  }
  return {
    permissionMode: 'default',
    canUseTool: (name: string, input: unknown, options: { signal: AbortSignal; toolUseID?: string }) => decide(name, object(input), options.toolUseID ?? '', options.signal),
    hooks: {
      PreToolUse: [{ timeout: 125, hooks: [async (raw: Data, id: string | undefined, options: { signal: AbortSignal }) => {
        const decision = await decide(text(raw['tool_name']), object(raw['tool_input']), text(raw['tool_use_id']) || id || '', options.signal)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.message, ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) } }
      }] }],
      PostToolUse: [{ hooks: [async (raw: Data) => finished(raw, object(raw['tool_response'])['is_error'] !== true)] }],
      PostToolUseFailure: [{ hooks: [async (raw: Data) => finished(raw, false)] }],
    },
  }
}
