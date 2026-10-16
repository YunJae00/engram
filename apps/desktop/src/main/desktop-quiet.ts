import type { QuietObservationDto, QuietPressResultDto, QuietReadResultDto, QuietSetResultDto, QuietStateDto } from '../shared/desktop.js'
import { bindDesktopForLane, desktopBinding, type DesktopBinding } from './desktop-access.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import type { DesktopMethod } from './desktop-host.js'
import { flog } from './flog.js'

// Provider calls avoid injected input and requested focus. A mutation waits
// while the person uses the target app; providers may still activate themselves.
const STILL_MS = 4_000
const WAIT_AT_MOST_MS = 60_000
const WAIT_POLL_MS = 500
const SETTLE_AT_MOST_MS = 180_000
const SETTLE_POLL_MS = 1_000
// Windows the quiet lane has read with controls in them, per chat: the hands
// tools are turned away from these, since the person would lose the mouse for
// nothing the providers could not do.
const COVERED_MS = 15 * 60_000
const covered = new Map<string, Map<string, { title: string; at: number }>>()

export function quietCovers(lane: string, app?: string): string | null {
  const windows = covered.get(lane)
  if (!windows) return null
  const wanted = app?.trim().toLocaleLowerCase()
  for (const [window, entry] of windows) {
    if (Date.now() - entry.at > COVERED_MS) { windows.delete(window); continue }
    if (!wanted || entry.title.toLocaleLowerCase().includes(wanted)) return entry.title
  }
  return null
}
export function forgetQuietCoverage(lane?: string): void { if (lane) covered.delete(lane); else covered.clear() }

// The frame around the app says which window is being worked in, without a
// banner or a stop key: nothing is taken, so there is nothing to give back.
// It fades a moment after the last call on that window.
const FRAME_LINGER_MS = 2_500
const frames = new Map<string, { binding: DesktopBinding; timer: ReturnType<typeof setTimeout> }>()
function showWorkFrame(binding: DesktopBinding): void {
  const held = frames.get(binding.lane)
  if (held) clearTimeout(held.timer)
  if (!held || held.binding !== binding) void binding.host.request('applicationFrame', scoped(binding)).catch(() => undefined)
  const timer = setTimeout(() => {
    frames.delete(binding.lane)
    if (!binding.host.closed) void binding.host.request('applicationFrameHide', scoped(binding)).catch(() => undefined)
  }, FRAME_LINGER_MS)
  timer.unref?.()
  frames.set(binding.lane, { binding, timer })
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted()
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error('cancelled')) }
  signal?.addEventListener('abort', abort, { once: true })
})

async function windowFor(lane: string, app: string, signal?: AbortSignal): Promise<DesktopBinding> {
  signal?.throwIfAborted()
  assertDesktopTurnNotStopped(lane)
  const binding = await bindDesktopForLane(lane, { app })
  signal?.throwIfAborted()
  if (!binding.readable || binding.stopped || binding.host.closed) throw new Error(`"${binding.name}" is not readable by this chat right now.`)
  return binding
}

const scoped = (binding: DesktopBinding): Record<string, unknown> => ({ window: binding.window, pid: binding.pid })

async function request<T>(binding: DesktopBinding, method: DesktopMethod, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const check = () => {
    signal?.throwIfAborted()
    assertDesktopTurnNotStopped(binding.lane)
    if (desktopBinding(binding.lane) !== binding || !binding.readable || binding.stopped || binding.host.closed) throw new Error('This app connection changed. Read the app again.')
  }
  check()
  const abort = () => binding.host.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await binding.host.request<T>(method, { ...scoped(binding), ...args })
    check()
    return result
  } finally { signal?.removeEventListener('abort', abort) }
}

export async function personBusyIn(binding: DesktopBinding, signal?: AbortSignal): Promise<boolean> {
  const state = await request<QuietStateDto>(binding, 'quietState', {}, signal)
  return state.foreground && state.idleMs < STILL_MS
}

// Wait for the person to leave the app alone before changing anything in it.
export async function awaitPersonAway(binding: DesktopBinding, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + WAIT_AT_MOST_MS
  let waited = false
  while (await personBusyIn(binding, signal)) {
    if (Date.now() >= until) throw new Error(`The person is using "${binding.name}" right now. Wait until they are done, or ask them.`)
    waited = true
    await pause(WAIT_POLL_MS, signal)
  }
  if (waited) flog('desktop-quiet', `waited for the person to leave ${binding.name}`)
}

export async function quietScan(lane: string, app: string, find: string | undefined, signal?: AbortSignal): Promise<QuietObservationDto> {
  const binding = await windowFor(lane, app, signal)
  showWorkFrame(binding)
  const result = await request<QuietObservationDto>(binding, 'quietScan', find ? { find } : {}, signal)
  signal?.throwIfAborted()
  if (result.controls.length > 0) {
    const windows = covered.get(lane) ?? new Map<string, { title: string; at: number }>()
    windows.set(binding.window, { title: binding.name, at: Date.now() })
    covered.set(lane, windows)
  }
  return result
}

export async function quietSet(lane: string, app: string, snapshot: string, control: string, text: string, expected: string | undefined, signal?: AbortSignal): Promise<QuietSetResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  showWorkFrame(binding)
  const result = await request<QuietSetResultDto>(binding, 'quietSet', { snapshot, control, text, ...(expected !== undefined ? { expected } : {}) }, signal)
  signal?.throwIfAborted()
  return result
}

export async function quietPress(lane: string, app: string, snapshot: string, control: string, signal?: AbortSignal): Promise<QuietPressResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  showWorkFrame(binding)
  const result = await request<QuietPressResultDto>(binding, 'quietPress', { snapshot, control }, signal)
  signal?.throwIfAborted()
  return result
}

// Read text once, or keep reading until it has stopped changing for a while:
// an answer still being written settles; a finished one returns at once.
export async function quietText(lane: string, app: string, snapshot: string | undefined, control: string | undefined, settleMs: number, signal?: AbortSignal): Promise<QuietReadResultDto & { settled: boolean; waitedMs: number }> {
  const binding = await windowFor(lane, app, signal)
  const read = () => { showWorkFrame(binding); return request<QuietReadResultDto>(binding, 'quietRead', { ...(snapshot ? { snapshot } : {}), ...(control ? { control } : {}) }, signal) }
  const started = Date.now()
  let last = await read()
  if (settleMs <= 0) return { ...last, settled: true, waitedMs: 0 }
  let stableSince = Date.now()
  for (;;) {
    await pause(SETTLE_POLL_MS, signal)
    const next = await read()
    if (next.text !== last.text) { last = next; stableSince = Date.now() }
    else if (Date.now() - stableSince >= settleMs) return { ...last, settled: true, waitedMs: Date.now() - started }
    if (Date.now() - started >= SETTLE_AT_MOST_MS) return { ...last, settled: false, waitedMs: Date.now() - started }
  }
}
