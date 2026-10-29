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
const covered = new Map<string, Map<string, { title: string; at: number; verdict: 'covered' | 'bare' }>>()

// What the quiet lane last found in a window: 'covered' when it exposed controls (the hands tools stay away),
// 'bare' when it exposed none or a provider refused to act (the hands tools may step in), 'unknown' before any read.
export function quietVerdict(lane: string, app?: string): { verdict: 'covered' | 'bare' | 'unknown'; title?: string } {
  const windows = covered.get(lane)
  if (!windows) return { verdict: 'unknown' }
  const wanted = app?.trim().toLocaleLowerCase()
  for (const [window, entry] of windows) {
    if (Date.now() - entry.at > COVERED_MS) { windows.delete(window); continue }
    if (!wanted || entry.title.toLocaleLowerCase().includes(wanted)) return { verdict: entry.verdict, title: entry.title }
  }
  return { verdict: 'unknown' }
}
export function quietCovers(lane: string, app?: string): string | null {
  const found = quietVerdict(lane, app)
  return found.verdict === 'covered' ? found.title ?? null : null
}
function remember(lane: string, binding: DesktopBinding, verdict: 'covered' | 'bare'): void {
  const windows = covered.get(lane) ?? new Map<string, { title: string; at: number; verdict: 'covered' | 'bare' }>()
  windows.set(binding.window, { title: binding.name, at: Date.now(), verdict })
  covered.set(lane, windows)
}
// A provider that offers a control but will not act on it hands the window to the hands tools.
const PROVIDER_LIMIT = /does not take text|cannot be pressed/
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
  // The window bound for this chat is kept while its title still matches: listing windows again costs up to seconds and re-selects every window.
  const current = desktopBinding(lane)
  const binding = current && current.readable && !current.stopped && !current.host.closed && current.name.toLocaleLowerCase().includes(app.trim().toLocaleLowerCase()) ? current : await bindDesktopForLane(lane, { app })
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
  const result = await binding.host.request<T>(method, { ...scoped(binding), ...args }, signal)
  check()
  return result
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

// Control names by snapshot, so an action can be judged by what it pressed.
const NAMED_SNAPSHOTS = 12
const named = new Map<string, Map<string, string>>()
export function quietControlName(snapshot: string, control: string): string | undefined { return named.get(snapshot)?.get(control) }

export async function quietScan(lane: string, app: string, find: string | undefined, signal?: AbortSignal): Promise<QuietObservationDto> {
  const binding = await windowFor(lane, app, signal)
  showWorkFrame(binding)
  const result = await request<QuietObservationDto>(binding, 'quietScan', find ? { find } : {}, signal)
  signal?.throwIfAborted()
  // Window chrome does not establish access to the app's working area.
  const chrome = /^(close|minimi[sz]e|maximi[sz]e|restore|닫기|최소화|최대화|복원)$/i
  const actionable = result.controls.some(control => !chrome.test(control.name ?? '') && (control.can?.set || control.can?.press))
  remember(lane, binding, actionable ? 'covered' : 'bare')
  named.set(result.snapshot, new Map(result.controls.map(control => [control.id, control.name])))
  while (named.size > NAMED_SNAPSHOTS) named.delete(named.keys().next().value!)
  return result
}

export async function quietSet(lane: string, app: string, snapshot: string, control: string, text: string, expected: string | undefined, signal?: AbortSignal): Promise<QuietSetResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  showWorkFrame(binding)
  const result = await request<QuietSetResultDto>(binding, 'quietSet', { snapshot, control, text, ...(expected !== undefined ? { expected } : {}) }, signal).catch((error: unknown) => { if (error instanceof Error && PROVIDER_LIMIT.test(error.message)) remember(lane, binding, 'bare'); throw error })
  signal?.throwIfAborted()
  return result
}

export async function quietPress(lane: string, app: string, snapshot: string, control: string, signal?: AbortSignal): Promise<QuietPressResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  showWorkFrame(binding)
  const result = await request<QuietPressResultDto>(binding, 'quietPress', { snapshot, control }, signal).catch((error: unknown) => { if (error instanceof Error && PROVIDER_LIMIT.test(error.message)) remember(lane, binding, 'bare'); throw error })
  signal?.throwIfAborted()
  return result
}

// While an app is still answering it offers a way to stop it, usually where
// its send control was; a status line that holds still is not an answer.
const STOP_CONTROL = /^\s*(stop|cancel)(\s+(generating|response|responding|streaming|answer))?\s*$|^\s*((응답|답변|생성)\s*)?(중지|정지|멈추기)\s*$/i
export const answeringControl = (observation: QuietObservationDto): string | undefined =>
  observation.controls.find(control => control.enabled && !control.offscreen && control.can.press && STOP_CONTROL.test(control.name))?.name

// Read text once, or keep reading until it has stopped changing for a while
// and the app no longer offers to stop an answer: a finished one returns at once.
export async function quietText(lane: string, app: string, snapshot: string | undefined, control: string | undefined, settleMs: number, signal?: AbortSignal): Promise<QuietReadResultDto & { settled: boolean; waitedMs: number; stillAnswering?: string }> {
  const binding = await windowFor(lane, app, signal)
  const read = () => { showWorkFrame(binding); return request<QuietReadResultDto>(binding, 'quietRead', { ...(snapshot ? { snapshot } : {}), ...(control ? { control } : {}) }, signal) }
  const started = Date.now()
  let last = await read()
  if (settleMs <= 0) return { ...last, settled: true, waitedMs: 0 }
  let stableSince = Date.now()
  let answering: string | undefined
  for (;;) {
    await pause(SETTLE_POLL_MS, signal)
    const next = await read()
    if (next.text !== last.text) { last = next; stableSince = Date.now() }
    else if (Date.now() - stableSince >= settleMs) {
      answering = answeringControl(await quietScan(lane, app, undefined, signal))
      if (!answering) return { ...last, settled: true, waitedMs: Date.now() - started }
      stableSince = Date.now()
    }
    if (Date.now() - started >= SETTLE_AT_MOST_MS) return { ...last, settled: false, waitedMs: Date.now() - started, ...(answering ? { stillAnswering: answering } : {}) }
  }
}
