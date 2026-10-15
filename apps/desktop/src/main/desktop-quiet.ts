import type { QuietObservationDto, QuietPressResultDto, QuietReadResultDto, QuietSetResultDto, QuietStateDto } from '../shared/desktop.js'
import { bindDesktopForLane, desktopBinding, type DesktopBinding } from './desktop-access.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import type { DesktopMethod } from './desktop-host.js'
import { flog } from './flog.js'

// Operating an app through its accessibility providers: the window is read and
// its controls are set or pressed without the foreground, the mouse or the
// keyboard changing hands. The person keeps working; nothing is captured.
//
// The one thing that must wait is the person themself: when they are in that
// very app and touching the keyboard or mouse, a value set under their hands
// would swallow what they type. So a change waits until they have been still
// for a moment, and gives up after a minute rather than barge in.
const STILL_MS = 4_000
const WAIT_AT_MOST_MS = 60_000
const WAIT_POLL_MS = 500
const SETTLE_AT_MOST_MS = 180_000
const SETTLE_POLL_MS = 1_000

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
  const result = await request<QuietObservationDto>(binding, 'quietScan', find ? { find } : {}, signal)
  signal?.throwIfAborted()
  return result
}

export async function quietSet(lane: string, app: string, snapshot: string, control: string, text: string, expected: string | undefined, signal?: AbortSignal): Promise<QuietSetResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  const result = await request<QuietSetResultDto>(binding, 'quietSet', { snapshot, control, text, ...(expected !== undefined ? { expected } : {}) }, signal)
  signal?.throwIfAborted()
  return result
}

export async function quietPress(lane: string, app: string, snapshot: string, control: string, signal?: AbortSignal): Promise<QuietPressResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  const result = await request<QuietPressResultDto>(binding, 'quietPress', { snapshot, control }, signal)
  signal?.throwIfAborted()
  return result
}

// Read text once, or keep reading until it has stopped changing for a while:
// an answer still being written settles; a finished one returns at once.
export async function quietText(lane: string, app: string, snapshot: string | undefined, control: string | undefined, settleMs: number, signal?: AbortSignal): Promise<QuietReadResultDto & { settled: boolean; waitedMs: number }> {
  const binding = await windowFor(lane, app, signal)
  const read = () => request<QuietReadResultDto>(binding, 'quietRead', { ...(snapshot ? { snapshot } : {}), ...(control ? { control } : {}) }, signal)
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
