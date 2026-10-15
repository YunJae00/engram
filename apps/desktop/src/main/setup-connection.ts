import { classifyEngineError, collectResult, engineBackoff, EngineCallError, ENGINE_BUDGETS, type Engine, type EngineCwd } from 'core'
import { connectionProbe } from './connection-probe.js'
import { markEngineOk, noteEngineFailure } from './engine-health.js'
import { cloudEngine } from './engine-cloud.js'
import { activeAccountProfile } from './account-profiles.js'

export async function verifySetupConnection(engine: Engine, workdir: EngineCwd, signal = AbortSignal.timeout(ENGINE_BUDGETS.ping), assertCurrent?: () => Promise<void>): Promise<void> {
  const name = engine.id === 'codex' ? 'ChatGPT' : engine.id === 'claude' ? 'Claude' : 'AI'
  signal.throwIfAborted()
  const profile = (engine as Engine & { accountProfile?: string }).accountProfile ?? (engine.id === 'claude' || engine.id === 'codex' ? activeAccountProfile(engine.id) : undefined)
  if ((engine.id === 'claude' || engine.id === 'codex') && profile !== activeAccountProfile(engine.id)) throw new Error('Your AI account changed. Try again.')
  if (engine.id === 'claude' || engine.id === 'codex') cloudEngine(engine.id, profile).forgetStatus?.()
  const detection = await connectionProbe(() => engine.detect())
  signal.throwIfAborted()
  if (detection.conclusive !== false && (!detection.installed || !detection.loggedIn)) throw new Error(`${name} is not verified. Connect it in AI settings and try again.`)
  let canceled!: () => void
  const stopped = new Promise<never>((_resolve, reject) => { canceled = () => reject(signal.reason); signal.addEventListener('abort', canceled, { once: true }) })
  try {
    await Promise.race([collectResult(engine, { prompt: 'Connection check only. Reply with OK. Do not use tools or read files.', workdir, disallowTools: true, requireToolIsolation: true, modelHint: 'fast', maxTokens: 8, timeoutMs: ENGINE_BUDGETS.ping, signal }), stopped])
    signal.throwIfAborted()
  } catch (error) {
    if (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'AbortError') throw signal.reason
    const kind = error instanceof EngineCallError ? error.kind : classifyEngineError(error instanceof Error ? error.message : String(error))
    await noteEngineFailure(engine, kind)
    const reason = kind === 'auth' ? 'Sign in again in AI settings.' : kind === 'quota' ? 'The provider limited this request. Reported account limits may differ. Retry later or choose another model or AI.' : 'It did not answer the connection check. Check your network and retry.'
    throw new Error(`${name} is not ready. ${reason}`)
  } finally { signal.removeEventListener('abort', canceled) }
  if ((engine.id === 'claude' || engine.id === 'codex') && profile !== activeAccountProfile(engine.id)) throw new Error('The AI account changed during the check.')
  await assertCurrent?.()
  signal.throwIfAborted()
  markEngineOk(engine.id, profile)
  engineBackoff.noteOk()
}
