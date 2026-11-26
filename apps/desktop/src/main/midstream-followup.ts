interface Said { text: string; taken(read: boolean): void }
const reading = new Set<string>()
const waiting = new Map<string, Said[]>()
const unread = new Map<string, string[]>()
const listeners = new Map<string, Set<() => void>>()

export const readingFollowUps = (channel: string): boolean => reading.has(channel)

export function openFollowUps(channel: string): void { reading.add(channel) }

export function closeFollowUps(channel: string): void {
  reading.delete(channel)
  const left = settle(channel, false)
  if (left.length) unread.set(channel, [...(unread.get(channel) ?? []), ...left])
}

export function followUp(channel: string, text: string): Promise<boolean> {
  if (!reading.has(channel)) { unread.set(channel, [...(unread.get(channel) ?? []), text]); return Promise.resolve(false) }
  return new Promise(taken => {
    waiting.set(channel, [...(waiting.get(channel) ?? []), { text, taken }])
    for (const wake of [...(listeners.get(channel) ?? [])]) wake()
  })
}

export function takeFollowUps(channel: string): string[] {
  const said = waiting.get(channel) ?? []
  waiting.delete(channel)
  for (const one of said) one.taken(true)
  return said.map(one => one.text)
}

export function storedUnread(channel: string, message: string): boolean {
  const left = unread.get(channel) ?? [], at = left.indexOf(message)
  if (at < 0) return false
  left.splice(at, 1)
  if (!left.length) unread.delete(channel)
  return true
}

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
  for (const one of channel === undefined ? [...waiting.keys()] : [channel]) settle(one, false)
}

function settle(channel: string, read: boolean): string[] {
  const said = waiting.get(channel) ?? []
  waiting.delete(channel)
  for (const one of said) one.taken(read)
  return said.map(one => one.text)
}
