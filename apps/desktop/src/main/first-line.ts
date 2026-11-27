import { promptFor, type Engine, type EngineCwd, type FirstLine } from 'core'
import { flog } from './flog.js'

export const FIRST_LINE_BUDGET_MS = 3000
export const FIRST_LINE_FALLBACK_MS = 1500
export const ACK_MAX = 60
export const SAFETY_LINE = { ko: '바로 확인해 볼게요.', en: 'Checking now.' }
const LINE_MAX = 140

export interface FirstLineAsk {
  channel: string
  message: string
  korean: boolean
  interactive: boolean
  studying: boolean
  limited: boolean
  secret: boolean
}
export type QuickTurn = { answer: string } | { brief: string } | undefined
type Voice = Pick<Engine, 'id' | 'quick'>
interface Pending { open: boolean; ready: boolean; line?: string; shown?: boolean; carried?: boolean; show?: (line: string) => void; hide?: () => void }
const turns = new Map<string, Pending>()
const log = (fields: Record<string, unknown>): void => flog('first-line', JSON.stringify(fields))

export function wantsFirstLine(ask: FirstLineAsk): string | null {
  if (!ask.channel.startsWith('bot-')) return 'channel'
  if (!ask.interactive) return 'background'
  if (ask.studying) return 'study'
  if (ask.limited) return 'limited'
  if (ask.secret) return 'secret'
  if (ask.message.trim().startsWith('/')) return 'command'
  return null
}

export function cleanLine(raw: string, max = LINE_MAX): string | undefined {
  const line = raw.trim().replace(/^(["'“‘])([^]*)(["'”’])$/, '$2').trim()
  if (!line || line.includes('\n') || line.includes('```') || [...line].length > max) return undefined
  return line
}

export async function beginFirstLine(ask: FirstLineAsk & { engine(): Promise<Voice | undefined>; workdir: EngineCwd; signal: AbortSignal; show(line: string): void; hide?(): void; said?(): Promise<readonly string[]> }): Promise<QuickTurn> {
  endFirstLine(ask.channel)
  const skip = wantsFirstLine(ask)
  if (skip) { log({ channel: ask.channel, outcome: 'skipped', reason: skip }); return undefined }
  const turn: Pending = { open: true, ready: false, show: ask.show, ...(ask.hide ? { hide: ask.hide } : {}) }
  turns.set(ask.channel, turn)
  const started = Date.now()
  const close = (outcome: string, reason: string): void => {
    if (!turn.open) return
    turn.open = false
    turn.line = undefined
    log({ channel: ask.channel, outcome, reason, ms: Date.now() - started })
  }
  const say = (line: string, outcome: string): void => {
    if (!turn.open || turn.line) return
    turn.line = line
    log({ channel: ask.channel, outcome, ms: Date.now() - started })
    reveal(ask.channel, turn, started)
  }
  const timer = setTimeout(() => say(ask.korean ? SAFETY_LINE.ko : SAFETY_LINE.en, 'fallback'), FIRST_LINE_FALLBACK_MS)
  timer.unref?.()
  ask.signal.addEventListener('abort', () => close('dropped', 'stopped'), { once: true })
  try {
    const engine = await ask.engine()
    if (ask.signal.aborted) return undefined
    if (engine?.id !== 'claude' || !engine.quick) { clearTimeout(timer); close('skipped', 'engine'); return undefined }
    const said = await ask.said?.().catch(() => []) ?? []
    if (ask.signal.aborted) return undefined
    const reply = await engine.quick(promptFor('quick', { message: ask.message, korean: ask.korean, said }), { workdir: ask.workdir, timeoutMs: FIRST_LINE_BUDGET_MS })
    if (ask.signal.aborted) return undefined
    if (reply.handOff === undefined) {
      if (!reply.text.trim()) { log({ channel: ask.channel, outcome: 'silent', ms: Date.now() - started }); return undefined }
      clearTimeout(timer)
      turn.open = false
      log({ channel: ask.channel, outcome: 'answered', ms: Date.now() - started })
      return { answer: reply.text.trim() }
    }
    const line = cleanLine(reply.text, ACK_MAX)
    log({ channel: ask.channel, outcome: 'handed', brief: reply.handOff, ms: Date.now() - started })
    if (line && !turn.line) { clearTimeout(timer); say(line, 'voiced') }
    return { brief: reply.handOff }
  } catch (error) {
    log({ channel: ask.channel, outcome: 'failed', reason: error instanceof Error ? error.message : String(error), ms: Date.now() - started })
    return undefined
  }
}

function reveal(channel: string, turn: Pending, started?: number): void {
  if (!turn.open || !turn.ready || !turn.line) return
  turn.open = false
  turn.shown = true
  turn.carried = true
  log({ channel, outcome: 'shown', ...(started ? { ms: Date.now() - started } : {}) })
  turn.show?.(turn.line)
}

export function firstLineReady(channel: string): void {
  const turn = turns.get(channel)
  if (!turn) return
  turn.ready = true
  reveal(channel, turn)
}

export function firstLineSpoke(channel: string): void {
  const turn = turns.get(channel)
  if (turn?.shown && turn.carried) { turn.carried = false; log({ channel, outcome: 'replaced' }); turn.hide?.() }
  if (!turn?.open) return
  turn.open = false
  turn.line = undefined
  log({ channel, outcome: 'dropped', reason: 'spoke' })
}

export function firstLineState(channel: string): FirstLine | undefined {
  const turn = turns.get(channel)
  if (!turn) return undefined
  if (turn.shown && turn.line) return { shown: turn.line }
  return turn.open ? { pending: true } : undefined
}

export function firstLineSaw(event: { type: string; channel?: string; reset?: boolean }): void {
  if (event.type !== 'chat:token' || !event.reset || !event.channel) return
  const turn = turns.get(event.channel)
  if (turn) turn.carried = false
}

export function firstLineCarried(channel: string): string | undefined {
  const turn = turns.get(channel)
  return turn?.shown && turn.carried ? turn.line : undefined
}

export function warmFirstLine(engine: Pick<Engine, 'id' | 'warmQuick'> | undefined, workdir: EngineCwd): void {
  if (process.env['ENGRAM_ENGINE'] === 'mock' || process.env['ENGRAM_ENGINE'] === 'none') return
  if (engine?.id !== 'claude' || !engine.warmQuick) return
  void engine.warmQuick(workdir).catch(() => undefined)
}

export function endFirstLine(channel: string): void {
  const turn = turns.get(channel)
  if (turn) turn.open = false
  turns.delete(channel)
}
