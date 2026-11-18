import type { QuietPressOptions } from 'core'
import { sparseDesktopTree, SCREEN_HINT } from './desktop-sparse.js'
import { appNameMatch, type DesktopReadOptions } from 'core'
import type { QuietObservationDto, QuietPressResultDto, QuietReadResultDto, QuietSetResultDto, QuietStateDto } from '../shared/desktop.js'
import { bindDesktopForLane, desktopBinding, refreshHiddenApp, type DesktopBinding } from './desktop-access.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import type { DesktopMethod } from './desktop-host.js'
import { showWorkPreview } from './work-preview.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'

const STILL_MS = 4_000
const WAIT_AT_MOST_MS = 60_000
const WAIT_POLL_MS = 500
const SETTLE_AT_MOST_MS = 180_000
const SETTLE_POLL_MS = 1_000
const COVERED_MS = 15 * 60_000
type Coverage = { title: string; aliases?: string[]; at: number; verdict: 'covered' | 'bare'; truncated?: boolean; searched?: boolean }
const covered = new Map<string, Map<string, Coverage>>()

export function quietVerdict(lane: string, app?: string): { verdict: 'covered' | 'bare' | 'unknown'; title?: string; truncated?: boolean; searched?: boolean } {
  const windows = covered.get(lane)
  if (!windows) return { verdict: 'unknown' }
  const wanted = app?.trim().toLocaleLowerCase()
  for (const [window, entry] of windows) {
    if (Date.now() - entry.at > COVERED_MS) { windows.delete(window); continue }
    if (!wanted || `window:${window}:0` === wanted || appNameMatch({ name: entry.title, aliases: entry.aliases }, wanted)) return { verdict: entry.verdict, title: entry.title, truncated: entry.truncated, searched: entry.searched }
  }
  return { verdict: 'unknown' }
}
function remember(lane: string, binding: DesktopBinding, verdict: 'covered' | 'bare', result: QuietObservationDto, find?: string, full = true): void {
  const windows = covered.get(lane) ?? new Map<string, Coverage>()
  const previous = windows.get(binding.window)
  windows.set(binding.window, { title: binding.name, aliases: binding.aliases, at: Date.now(), verdict: full || !previous ? verdict : previous.verdict, truncated: result.truncated, searched: previous?.searched === true || (!!find && result.searchComplete === true) })
  covered.set(lane, windows)
}
export function forgetQuietCoverage(lane?: string): void { if (lane) covered.delete(lane); else covered.clear() }

const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted()
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error('cancelled')) }
  signal?.addEventListener('abort', abort, { once: true })
})

async function windowFor(lane: string, app: string, signal?: AbortSignal): Promise<DesktopBinding> {
  signal?.throwIfAborted()
  assertDesktopTurnNotStopped(lane)
  const current = desktopBinding(lane)
  const binding = current && current.readable && !current.stopped && !current.host.closed && (current.source === app.trim() || appNameMatch(current, app, true)) ? current : await bindDesktopForLane(lane, { app })
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
  if (['quietSet', 'quietPress', 'quietRead'].includes(method) && result && typeof result === 'object') {
    const receipt = result as { how?: string; pressed?: string; foregroundChanged?: boolean; foregroundRestored?: boolean; foregroundTaken?: boolean }
    if ((receipt.how && receipt.how !== 'ax') || receipt.pressed === 'posted') flog('harness', JSON.stringify({ kind: 'host', operation: 'quiet-posted-input', how: receipt.how ?? receipt.pressed, method }))
    if (receipt.foregroundChanged) {
      const tool = method === 'quietSet' ? 'app_set' : method === 'quietPress' ? 'app_press' : 'app_text'
      flog('desktop-foreground', JSON.stringify({ lane: binding.lane, tool, app: binding.name, restored: receipt.foregroundRestored === true }))
      flog('desktop-foreground', JSON.stringify({ lane: binding.lane, tool: 'restoreForeground', app: binding.name, restored: receipt.foregroundRestored === true }))
      if (receipt.foregroundRestored) flog('harness', JSON.stringify({ kind: 'host', operation: 'foreground-restored', lane: binding.lane, tool }))
      if (!receipt.foregroundRestored) {
        receipt.foregroundTaken = true
        broadcast({ type: 'task:notice', message: `${binding.name} brought its window forward · continuing`, foreground: { lane: binding.lane, app: binding.name } })
      }
    }
  }
  return result
}

async function personBusyIn(binding: DesktopBinding, signal?: AbortSignal): Promise<boolean> {
  const state = await request<QuietStateDto>(binding, 'quietState', {}, signal)
  return state.foreground && state.idleMs < STILL_MS
}

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

const NAMED_SNAPSHOTS = 12
const named = new Map<string, QuietObservationDto>()
export function quietSnapshot(snapshot: string): QuietObservationDto | undefined { return named.get(snapshot) }
export function quietControlName(snapshot: string, control: string): string | undefined { return named.get(snapshot)?.controls.find(item => item.id === control)?.name }

export async function quietScan(lane: string, app: string, find: string | undefined, signal?: AbortSignal, options: DesktopReadOptions = {}): Promise<QuietObservationDto> {
  const binding = await refreshHiddenApp(await windowFor(lane, app, signal))
  const result = await request<QuietObservationDto>(binding, 'quietScan', { ...options, ...(find ? { find } : {}) }, signal)
  signal?.throwIfAborted()
  const chrome = /^(close|minimi[sz]e|maximi[sz]e|restore|닫기|최소화|최대화|복원)$/i
  const actionable = result.controls.some(control => !chrome.test(control.name ?? '') && (control.can?.set || control.can?.press))
  showWorkPreview(binding)
  result.sparseTree = !find && sparseDesktopTree(result)
  if (result.sparseTree) result.hint = SCREEN_HINT
  remember(lane, binding, actionable && !result.sparseTree ? 'covered' : 'bare', result, find, !find && !options.root && options.mode !== 'skeleton')
  result.find = find
  named.set(result.snapshot, result)
  while (named.size > NAMED_SNAPSHOTS) named.delete(named.keys().next().value!)
  return result
}

export async function quietSet(lane: string, app: string, snapshot: string, control: string, text: string, expected: string | undefined, signal?: AbortSignal): Promise<QuietSetResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  const result = await request<QuietSetResultDto>(binding, 'quietSet', { snapshot, control, text, ...(expected !== undefined ? { expected } : {}) }, signal)
  signal?.throwIfAborted()
  return result
}

export async function quietPress(lane: string, app: string, snapshot: string, control: string, signal?: AbortSignal, options?: QuietPressOptions): Promise<QuietPressResultDto> {
  const binding = await windowFor(lane, app, signal)
  await awaitPersonAway(binding, signal)
  const result = await request<QuietPressResultDto>(binding, 'quietPress', { snapshot, control, ...options }, signal)
  signal?.throwIfAborted()
  return result
}

const STOP_CONTROL = /^\s*(stop|cancel)(\s+(generating|response|responding|streaming|answer))?\s*$|^\s*((응답|답변|생성)\s*)?(중지|정지|멈추기)\s*$/i
const answeringControl = (observation: QuietObservationDto): string | undefined =>
  observation.controls.find(control => control.enabled && !control.offscreen && control.can.press && STOP_CONTROL.test(control.name))?.name

export async function quietText(lane: string, app: string, snapshot: string | undefined, control: string | undefined, settleMs: number, signal?: AbortSignal): Promise<QuietReadResultDto & { settled: boolean; waitedMs: number; stillAnswering?: string }> {
  const binding = await windowFor(lane, app, signal)
  const read = () => request<QuietReadResultDto>(binding, 'quietRead', { ...(snapshot ? { snapshot } : {}), ...(control ? { control } : {}) }, signal)
  const started = Date.now()
  let last = await read()
  if (last.truncated) return { ...last, settled: false, waitedMs: 0 }
  if (settleMs <= 0) return { ...last, settled: true, waitedMs: 0 }
  let stableSince = Date.now()
  let answering: string | undefined
  for (;;) {
    await pause(SETTLE_POLL_MS, signal)
    const next = await read()
    if (next.truncated) return { ...next, settled: false, waitedMs: Date.now() - started }
    if (next.text !== last.text) { last = next; stableSince = Date.now() }
    else if (Date.now() - stableSince >= settleMs) {
      answering = answeringControl(await quietScan(lane, app, undefined, signal))
      if (!answering) return { ...last, settled: true, waitedMs: Date.now() - started }
      stableSince = Date.now()
    }
    if (Date.now() - started >= SETTLE_AT_MOST_MS) return { ...last, settled: false, waitedMs: Date.now() - started, ...(answering ? { stillAnswering: answering } : {}) }
  }
}
