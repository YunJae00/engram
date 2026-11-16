import type { ChatRequestDto } from '../shared/types.js'
import { flog } from './flog.js'

type Chat = (request: ChatRequestDto) => Promise<void>
// Words said while a turn worked, each answered as its own turn once that turn ends.
const waiting = new Map<string, string[]>()
// The follow-up whose turn is running in each channel; also marks a drain in progress.
const answeringNow = new Map<string, string>()
const stops = new Map<string, number>()
let allStops = 0
let run: Chat | undefined
let busy: (channel: string) => boolean = () => false

export function answerFollowUps(chat: Chat, isBusy: (channel: string) => boolean): Chat {
  run = chat
  busy = isBusy
  return request => chat(request).finally(() => afterTurn(request.channel ?? `bot-${request.botId}`))
}

export function followUpFor(channel: string): (text: string) => void {
  const ticket = `${allStops}:${stops.get(channel) ?? 0}`
  return text => {
    if (ticket !== `${allStops}:${stops.get(channel) ?? 0}`) return
    waiting.set(channel, [...(waiting.get(channel) ?? []), text])
    for (const wake of [...(listeners.get(channel) ?? [])]) wake()
    afterTurn(channel)
  }
}

// The running turn takes the words said to it so far (handed over with its next tool result): it answers them itself, so they get no turn of their own.
// grokbar T1/T2: "아 대구도 추가해" belongs in the answer under way, not in a second one after it. Words nobody took are still answered as their own turn.
export function takeFollowUps(channel: string): string[] {
  const said = waiting.get(channel) ?? []
  waiting.delete(channel)
  return said
}

// Resolves once words are waiting for this channel's running turn; never after the signal aborts.
const listeners = new Map<string, Set<() => void>>()
export function followUpSaid(channel: string, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (waiting.get(channel)?.length) return resolve()
    const mine = listeners.get(channel) ?? new Set<() => void>()
    const wake = (): void => { mine.delete(wake); if (!mine.size) listeners.delete(channel); if (!signal.aborted) resolve() }
    listeners.set(channel, mine.add(wake))
    signal.addEventListener('abort', wake, { once: true })
  })
}

export function dropFollowUps(channel?: string): void {
  if (channel === undefined) { allStops++; waiting.clear(); return }
  stops.set(channel, (stops.get(channel) ?? 0) + 1)
  waiting.delete(channel)
}

export const followingUp = (channel: string): boolean => answeringNow.has(channel)
export const savedFollowUp = (channel: string, message: string): boolean => answeringNow.get(channel) === message
export function afterTurn(channel: string): void { void drain(channel) }

async function drain(channel: string): Promise<void> {
  if (!run || answeringNow.has(channel) || busy(channel)) return
  try {
    while (!busy(channel)) {
      const next = waiting.get(channel)?.shift()
      if (next === undefined) break
      answeringNow.set(channel, next)
      await run({ engineId: '', botId: channel.slice('bot-'.length), channel, message: next, history: [] }).catch(error => flog('follow-up', error))
    }
  } finally {
    answeringNow.delete(channel)
    if (!waiting.get(channel)?.length) waiting.delete(channel)
  }
}
