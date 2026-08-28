import { ipcMain } from 'electron'
import {
  collectResult,
  factScore,
  forgetFact,
  loadBotMemory,
  memorableTurn,
  parseFactLines,
  recordFacts,
  REMEMBER_TOKENS,
  rememberPrompt,
  withoutSecrets,
  type Engine,
  type VaultPaths,
} from 'core'
import type { BotFactDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'

type EngineCwd = Parameters<typeof collectResult>[1]['workdir']

// What a comet remembers of the person, and how it comes to remember it: one
// short model call after a turn worth keeping, run while the model is still
// held for the turn so it costs no reload. The answer has already been
// delivered; only the next send waits on it.

const REMEMBER_TIMEOUT_MS = 60_000

export function registerCometMemoryIpc(paths: VaultPaths): void {
  ipcMain.handle('bots:memory', async (_e, botId: string): Promise<BotFactDto[]> => {
    const file = await loadBotMemory(paths, botId)
    const now = new Date()
    return [...file.facts]
      .sort((a, b) => factScore(b, now) - factScore(a, now))
      .map((f) => ({ id: f.id, text: f.text, at: f.at, touchedAt: f.touchedAt }))
  })
  ipcMain.handle('bots:memoryForget', (_e, botId: string, factId: string) => forgetFact(paths, botId, factId))
}

export async function rememberTurn(deps: {
  engine: Engine
  workdir: EngineCwd
  paths: VaultPaths
  botId: string
  channel: string
  message: string
  answer: string
  signal?: AbortSignal
}): Promise<void> {
  if (!memorableTurn(deps.message, deps.answer)) return
  const known = (await loadBotMemory(deps.paths, deps.botId)).facts.map((f) => f.text)
  let raw = ''
  try {
    raw = await collectResult(deps.engine, {
      prompt: rememberPrompt(
        { user: withoutSecrets(deps.message, deps.message), answer: withoutSecrets(deps.answer, deps.message) },
        known,
      ),
      workdir: deps.workdir,
      disallowTools: true,
      timeoutMs: REMEMBER_TIMEOUT_MS,
      modelHint: 'fast',
      maxTokens: REMEMBER_TOKENS,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
  } catch (err) {
    if (deps.signal?.aborted) return
    flog('comet-memory', `remembering failed — ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const lines = parseFactLines(raw, known)
  const change = await recordFacts(deps.paths, deps.botId, lines)
  flog('comet-memory', `kept ${change.added} new, ${change.touched} said again`)
  broadcast({ type: 'comet:remembered', channel: deps.channel, botId: deps.botId, added: change.added, touched: change.touched })
}
