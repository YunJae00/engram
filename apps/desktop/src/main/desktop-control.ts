import { screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopControlLease, DESKTOP_TOOL_ISOLATION_MESSAGE, type DesktopAction, type Engine } from 'core'
import type { DesktopControlStatusDto, DesktopEngineId, DesktopObservationDto } from '../shared/desktop.js'
import { bindDesktopForLane, desktopBinding, desktopChanged, setDesktopReleaseHook, type DesktopBinding } from './desktop-access.js'
import { hideControlOverlay, overlayPointer, prepareControlOverlay, updateControlOverlay } from './desktop-overlay.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { DesktopHost } from './desktop-host.js'
import { replacementTarget } from './desktop-guarded-sequence.js'

// Control is taken by the comet's first reading of an app and given back by
// an explicit stop. Pointer motion is harmless; native control separates
// physical input from agent input. Esc, Stop, or a click outside the target
// ends control for the turn. Interrupted preparation can wait for held keys.
const LEASE_TTL_MS = 60 * 60_000
const HANDS_STILL_MS = 4_000
const HANDS_AT_MOST_MS = 5 * 60_000
const HANDS_POLL_MS = 250
const REBIND_TRIES = 3
const LABEL: Record<DesktopEngineId, string> = { claude: 'Claude', codex: 'ChatGPT' }
const RESUMABLE = /returned control to the user|pointer target changed|window or desktop changed|control expired/i

const lease = new DesktopControlLease({ onChange: desktopChanged, ttlMs: LEASE_TTL_MS })
type DesktopEngine = Pick<Engine, 'id' | 'desktopToolIsolation'>
let engineForControl: () => Promise<DesktopEngine | undefined> = async () => undefined
let active: { binding: DesktopBinding; token: string; engine: DesktopEngineId; nativeGrant: string; native?: string; bindingNative?: boolean; working?: boolean } | undefined
let paused: { lane: string; engine: DesktopEngineId; resumable: boolean; release?: () => void } | undefined
let starting: Promise<DesktopBinding> | undefined
let startingLane: string | undefined
let cancellation = 0
const stoppedTurns = new Map<string, string>()
const observations = new Map<string, DesktopObservationDto>()
const observationTimes = new WeakMap<DesktopObservationDto, number>()
const operations = new Map<string, Promise<unknown>>()
let launching: { lane: string; host: DesktopHost } | undefined

setDesktopReleaseHook((lane, reason) => stopDesktopForLane(lane, reason, RESUMABLE.test(reason)))

export function setDesktopEngineResolver(resolve: typeof engineForControl): void { engineForControl = resolve }
export function assertDesktopChatEngine(lane: string, engine: DesktopEngine | undefined): void {
  if (!desktopBinding(lane)?.readable) return
  const held = active?.binding.lane === lane ? active : undefined
  if (engine?.desktopToolIsolation === true && (!held || held.engine === engine.id)) return
  stopDesktopForLane(lane, DESKTOP_TOOL_ISOLATION_MESSAGE)
  throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
}

function engineOf(id: string): DesktopEngineId { return id === 'codex' ? 'codex' : 'claude' }

export function desktopControlStatus(): DesktopControlStatusDto {
  const state = lease.state()
  const engine = active?.engine ?? paused?.engine
  return {
    ...(state.state === 'running' && !active?.native ? { ...state, state: 'ready' } : state),
    inputActive: active?.working === true,
    ...(engine ? { engine, engineLabel: LABEL[engine] } : {}),
    ...(state.state === 'paused' ? { resumable: paused?.resumable === true, ...(state.lane && stoppedTurns.has(state.lane) ? { reason: stoppedTurns.get(state.lane) } : {}) } : {}),
  }
}

function announce(): void {
  const status = desktopControlStatus()
  if (status.state === 'running') updateControlOverlay(status)
  else hideControlOverlay()
  broadcast({ type: 'desktop:control', control: status })
}

export function stopDesktopControl(reason = 'You stopped computer control.', resumable = false): void {
  if (!resumable) {
    cancellation++
    const lane = active?.binding.lane ?? paused?.lane ?? startingLane ?? launching?.lane
    if (lane) stoppedTurns.set(lane, reason)
  }
  if (active || startingLane) flog('desktop-control-stop', reason)
  const held = active
  launching?.host.close()
  active = undefined
  observations.clear()
  lease.stop(reason)
  if (held) {
    paused = { lane: held.binding.lane, engine: held.engine, resumable }
    held.binding.revision++
    if (held.native) void held.binding.host.request('stop', { lease: held.native }).catch(() => held.binding.host.close())
    else if (held.bindingNative) held.binding.host.close()
  } else if (paused) paused = { ...paused, resumable: paused.resumable && resumable }
  paused?.release?.()
  announce()
}

function stoppedError(lane: string): Error {
  const reason = stoppedTurns.get(lane) ?? lease.state().reason ?? 'Computer control stopped.'
  const detail = /^(You stopped computer control\.?|Escape pressed|Stopped by the user)$/i.test(reason)
    ? 'The person took the computer back with Esc or Stop.' : reason
  return new Error(`${detail} Computer control was cancelled for this turn. Ask before using it again.`)
}

// Esc or the Stop button: the person's word, for the rest of this turn.
export function stopDesktopFromUi(): void {
  if (paused && !paused.resumable && !active) { cancellation++; paused.release?.(); lease.reset(); paused = undefined; announce() }
  else stopDesktopControl()
}

// The pill's "Resume now": the stillness wait ends here.
export function resumeDesktopControl(): void { paused?.release?.() }

export function stopDesktopForLane(lane: string, reason = 'This chat stopped.', resumable = false): void {
  if (lease.state().lane === lane || active?.binding.lane === lane || startingLane === lane || launching?.lane === lane) stopDesktopControl(reason, resumable)
}

export async function openDesktopApp(lane: string, app: string, signal?: AbortSignal): Promise<string> {
  const epoch = cancellation
  signal?.throwIfAborted()
  const engine = await engineForControl()
  signal?.throwIfAborted()
  if (stoppedTurns.has(lane) || epoch !== cancellation) throw stoppedError(lane)
  if (engine?.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
  if (launching || starting || (active && active.binding.lane !== lane)) throw new Error('Another desktop operation is in progress.')
  const host = new DesktopHost()
  const pending = { lane, host }
  launching = pending
  const abort = () => host.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await host.request('openApp', { app })
    signal?.throwIfAborted()
    if (epoch !== cancellation) throw stoppedError(lane)
    return 'Windows accepted the launch request. Use list_windows to find the actual window, then read_desktop to verify it. A launch request alone does not prove the app is ready.'
  } finally {
    signal?.removeEventListener('abort', abort)
    if (launching === pending) launching = undefined
    host.close()
  }
}

// A turn's control ends with the turn. The app stays connected and readable,
// so the next turn picks it up without asking; only the native hold, the
// hooks and the banner go.
export function endDesktopTurn(lane: string): void {
  stoppedTurns.delete(lane)
  if (active?.binding.lane !== lane && lease.state().lane !== lane && startingLane !== lane) return
  const held = active
  cancellation++
  active = undefined
  observations.clear()
  lease.reset()
  paused = undefined
  if (held?.native) void held.binding.host.request('stop', { lease: held.native }).catch(() => held.binding.host.close())
  else if (held?.bindingNative) held.binding.host.close()
  announce()
}

async function beginNative(held: NonNullable<typeof active>): Promise<void> {
  lease.assertActive(held.token, held.binding.lane)
  if (held.native && held.working) return
  held.bindingNative = true
  try {
    const before = await held.binding.host.request<{ intervention: string }>('inputState', {})
    const overlay = await prepareControlOverlay(desktopControlStatus())
    const after = await held.binding.host.request<{ intervention: string; escaped: boolean }>('inputState', {})
    if (after.escaped && after.intervention !== before.intervention) {
      stopDesktopControl('Escape pressed')
      throw stoppedError(held.binding.lane)
    }
    lease.assertActive(held.token, held.binding.lane)
    if (active !== held) throw new Error('Computer control was cancelled before it started.')
    if (held.native) {
      await held.binding.host.request('work', { window: held.binding.window, pid: held.binding.pid, lease: held.native, overlay })
      lease.assertActive(held.token, held.binding.lane)
      held.working = true
      announce()
      return
    }
    const result = await held.binding.host.request<{ lease: string }>('bind', { window: held.binding.window, pid: held.binding.pid, grant: held.nativeGrant, overlay })
    lease.assertActive(held.token, held.binding.lane)
    if (active !== held || !result?.lease) throw new Error('Computer control was cancelled before it started.')
    held.native = result.lease
    held.working = true
    desktopChanged()
  } finally { held.bindingNative = false }
}

// Keep snapshots between tool calls, but never hold physical input while the
// model is thinking, generating an answer, or running a non-desktop tool.
export async function withDesktopActivity<T>(lane: string, run: () => Promise<T>): Promise<T> {
  const previous = operations.get(lane)
  const operation = (async () => {
    await previous?.catch(() => undefined)
    try { return await run() }
    finally {
      const held = active
      if (held?.binding.lane === lane && held.native && held.working) {
        try {
          await held.binding.host.request('idle', { window: held.binding.window, pid: held.binding.pid, lease: held.native })
          if (active === held) { held.working = false; announce() }
        } catch { if (active === held) stopDesktopControl('Computer control could not release input safely.') }
      }
    }
  })()
  operations.set(lane, operation)
  try { return await operation }
  finally { if (operations.get(lane) === operation) operations.delete(lane) }
}

function cursor(): { x: number; y: number } | null {
  try { const point = screen.getCursorScreenPoint(); return { x: point.x, y: point.y } } catch { return null }
}

// The person's hands are on the machine: wait until the mouse has been still
// for a moment, or until they press Resume. Typing is caught by the native
// bind, which refuses while any key is down.
async function awaitStillHands(signal?: AbortSignal): Promise<void> {
  const from = Date.now()
  let last = cursor()
  let stillSince = Date.now()
  let released = false
  if (paused) paused.release = () => { released = true }
  while (!released && Date.now() - from < HANDS_AT_MOST_MS) {
    if (signal?.aborted) throw new Error('canceled')
    await new Promise((resolve) => setTimeout(resolve, HANDS_POLL_MS))
    if (!paused?.resumable) throw new Error('Computer control was cancelled.')
    const host = desktopBinding(paused.lane)?.host
    if (!host || host.closed) throw new Error('Reconnect the app before continuing computer control.')
    const input = await host.request<{ idleMs: number; escaped: boolean }>('inputState', {})
    if (input.escaped) { stopDesktopControl('Escape pressed'); throw new Error('The person took the computer back with Esc.') }
    if (!Number.isFinite(input.idleMs) || input.idleMs < HANDS_STILL_MS) stillSince = Date.now()
    const now = cursor()
    if (!/user input changed|release your keyboard/i.test(lease.state().reason ?? '') && (!last || !now || now.x !== last.x || now.y !== last.y)) { stillSince = Date.now(); last = now }
    if (Date.now() - stillSince >= HANDS_STILL_MS) return
  }
  if (!released) throw new Error('The person kept using the computer. Ask them when you may continue.')
}

async function takeControl(lane: string, engine: DesktopEngineId, check: () => void, app?: string): Promise<DesktopBinding> {
  const binding = await bindDesktopForLane(lane, app ? { app } : {})
  check()
  const token = lease.reserve(lane, binding.name)
  const held: NonNullable<typeof active> = { binding, token, engine, nativeGrant: randomUUID() }
  active = held
  paused = undefined
  lease.activate(token)
  try { await beginNative(held) }
  catch (error) {
    if (active === held) stopDesktopControl(error instanceof Error ? error.message : 'Computer control did not start.', /user input changed|release your keyboard/i.test(String(error)))
    throw error
  }
  announce()
  return binding
}

// The one door to the computer: the first reading takes it, a hands-on pause
// waits and takes it again, and a different app is a re-take. Serialized so
// two tool calls in flight cannot bind twice.
export async function ensureDesktopControl(lane: string, options: { app?: string; signal?: AbortSignal } = {}): Promise<DesktopBinding> {
  const epoch = cancellation
  const check = () => {
    options.signal?.throwIfAborted()
    if (epoch !== cancellation) {
      if (stoppedTurns.has(lane)) throw stoppedError(lane)
      throw new Error('Computer control was cancelled. Ask before using it again.')
    }
  }
  options.signal?.throwIfAborted()
  while (starting) { await starting.catch(() => undefined); check() }
  const run = (async () => {
    const engine = await engineForControl()
    check()
    if (stoppedTurns.has(lane)) throw stoppedError(lane)
    if (engine?.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
    const id = engineOf(engine.id)
    if ((active && active.binding.lane !== lane) || (paused?.resumable && paused.lane !== lane)) throw new Error('Another chat is using the computer right now. Wait for it to finish.')
    // A hold the comet gives up itself - it expired, or it is moving to
    // another app - is no one's hands: nothing to wait out before retaking.
    if (active && lease.state().state !== 'running') { stopDesktopControl('Computer control expired.', true); paused = undefined }
    if (active) {
      const wanted = options.app?.trim().toLocaleLowerCase()
      if (!wanted || active.binding.name.toLocaleLowerCase().includes(wanted)) { await beginNative(active); return active.binding }
      stopDesktopControl('The comet moved to another app.', true)
      paused = undefined
    }
    if (paused && paused.lane === lane && !paused.resumable) throw stoppedError(lane)
    let tries = 0
    for (;;) {
      if (paused?.lane === lane) await awaitStillHands(options.signal)
      check()
      try { return await takeControl(lane, id, check, options.app) }
      catch (error) {
        if (++tries >= REBIND_TRIES || !/user input changed|release your keyboard/i.test(String(error))) throw error
      }
    }
  })()
  starting = run
  startingLane = lane
  try { return await run } finally { if (starting === run) { starting = undefined; startingLane = undefined } }
}

// Kept for the manual route: the same door, opened from the app itself.
export async function startDesktopControl(lane: string): Promise<DesktopControlStatusDto> {
  stoppedTurns.delete(lane)
  if (paused?.lane === lane && !paused.resumable) { lease.reset(); paused = undefined }
  await ensureDesktopControl(lane)
  return desktopControlStatus()
}

async function readBoundDesktop(lane: string, signal?: AbortSignal, agent = false, app?: string, focusedOnly = false): Promise<DesktopObservationDto> {
  signal?.throwIfAborted()
  const binding = agent ? await ensureDesktopControl(lane, { ...(app ? { app } : {}), ...(signal ? { signal } : {}) }) : desktopBinding(lane)
  if (!binding?.readable) throw new Error('No app is connected to this chat yet.')
  const revision = binding.revision
  const held = active?.binding === binding ? active : undefined
  const read = () => binding.host.request<DesktopObservationDto>('observe', {
    window: binding.window, pid: binding.pid, ...(held?.native ? { lease: held.native } : {}), ...(focusedOnly ? { focusedOnly: true } : {}),
  })
  const result = agent && held ? await lease.run(held.token, lane, read) : await read()
  signal?.throwIfAborted()
  if (desktopBinding(lane) !== binding || !binding.readable || binding.revision !== revision) throw new Error('The app changed while it was being read. Observe it again.')
  if (!result || typeof result.snapshot !== 'string' || !Array.isArray(result.nodes) || !result.bounds || ![result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height].every(Number.isFinite) || result.bounds.width <= 0 || result.bounds.height <= 0) throw new Error('This app did not provide a valid observation.')
  observations.set(lane, result)
  observationTimes.set(result, Date.now())
  return result
}

export async function readControlledDesktop(lane: string, signal?: AbortSignal, agent = false, app?: string, focusedOnly = false): Promise<DesktopObservationDto> {
  const stop = () => { if (active?.binding.lane === lane) stopDesktopForLane(lane, 'This chat was cancelled.') }
  if (agent) signal?.addEventListener('abort', stop, { once: true })
  try { return await readBoundDesktop(lane, signal, agent, app, focusedOnly) }
  catch (error) {
    if (agent && active?.binding.lane === lane && !(error instanceof Error && /still|took the computer back|Another chat/.test(error.message))) stopDesktopForLane(lane, error instanceof Error ? error.message : 'The app could not be observed safely.')
    throw error
  } finally { signal?.removeEventListener('abort', stop) }
}

export function desktopObservation(lane: string, snapshot: string): DesktopObservationDto {
  const observation = observations.get(lane)
  if (!observation || observation.snapshot !== snapshot) throw new Error('Observe the app again before acting. This snapshot is stale.')
  return observation
}

export async function actOnDesktop(lane: string, action: DesktopAction, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  await ensureDesktopControl(lane, signal ? { signal } : {})
  const held = active
  const token = lease.tokenFor(lane)
  if (!held?.native || !token || held.token !== token || held.binding.lane !== lane) throw new Error('Computer control is not active. Observe the app first.')
  let observation = observations.get(lane)
  if (!observation || observation.snapshot !== action.snapshot) throw new Error('Observe the app again before acting. This snapshot is stale.')
  if (Date.now() - (observationTimes.get(observation) ?? 0) >= 10000) {
    const previous = observation
    observation = await readControlledDesktop(lane, signal, true)
    if (JSON.stringify([previous.bounds, previous.captureBounds]) !== JSON.stringify([observation.bounds, observation.captureBounds])) throw new Error('The app geometry changed while planning. Inspect the fresh observation before acting.')
    if ((action.kind === 'click' && 'element' in action) || action.kind === 'replace') {
      const element = action.element
      const target = action.kind === 'replace' ? replacementTarget(previous, element, action.expected) : previous.nodes.find((node) => node.id === element)
      const replacing = action.kind === 'replace'
      const matches = observation.nodes.filter((node) => target && (!replacing || node.runtimeId === target.runtimeId) && node.name === target.name && node.controlType === target.controlType && JSON.stringify(node.bounds) === JSON.stringify(target.bounds))
      if (matches.length !== 1) throw new Error('The planned control changed or is ambiguous. Inspect the fresh observation before acting.')
      action = { ...action, element: matches[0]!.id }
    } else if (action.kind === 'key' || action.kind === 'type') {
      if (!previous.focusedControl || observation.focusedControl !== previous.focusedControl) throw new Error('Keyboard focus changed while planning. Inspect the fresh observation before acting.')
    } else throw new Error('Observe the app again before using a planned coordinate or scroll action.')
    action = { ...action, snapshot: observation.snapshot }
  }
  if (action.kind === 'replace') replacementTarget(observation, action.element, action.expected)
  observations.delete(lane)
  const stop = () => { if (active?.token === token) stopDesktopForLane(lane, 'This chat was cancelled.') }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    return await lease.run(token, lane, async () => {
      signal?.throwIfAborted()
      const args: Record<string, unknown> = { window: held.binding.window, pid: held.binding.pid, lease: held.native, snapshot: action.snapshot }
      if (action.kind === 'click') {
        if ('element' in action) args['element'] = action.element
        else {
          const bounds = observation.captureBounds
          if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('Observe an app with verified client coordinates before clicking by position.')
          args['x'] = Math.round(bounds.x + action.x * (bounds.width - 1))
          args['y'] = Math.round(bounds.y + action.y * (bounds.height - 1))
        }
      } else if (action.kind === 'replace') Object.assign(args, { element: action.element, expected: action.expected, text: action.text })
      else if (action.kind === 'type') args['text'] = action.text
      else if (action.kind === 'scroll') args['delta'] = action.delta
      else args['key'] = action.key
      await held.binding.host.request(action.kind, args)
      signal?.throwIfAborted()
      if (action.kind === 'click') {
        const point = cursor()
        if (point) overlayPointer(point, true)
      }
      return 'Input was dispatched to the app. Observe it again to verify the outcome before claiming success or taking another action.'
    })
  } catch (error) {
    if (active?.token === token) stopDesktopForLane(lane, 'Computer control stopped after an action could not be verified.')
    throw error
  } finally { signal?.removeEventListener('abort', stop) }
}
