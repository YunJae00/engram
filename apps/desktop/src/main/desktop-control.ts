import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopControlLease, DESKTOP_TOOL_ISOLATION_MESSAGE, type DesktopAction, type Engine } from 'core'
import type { DesktopControlStatusDto, DesktopObservationDto } from '../shared/desktop.js'
import { desktopBinding, desktopChanged, desktopOwner, setDesktopReleaseHook, type DesktopBinding } from './desktop-access.js'

const lease = new DesktopControlLease({ onChange: desktopChanged })
type DesktopEngine = Pick<Engine, 'id' | 'desktopToolIsolation'>
let engineForControl: () => Promise<DesktopEngine | undefined> = async () => undefined
let checking: { binding: DesktopBinding } | undefined
let active: { binding: DesktopBinding; token: string; engineId: string; nativeGrant: string; native?: string; bindingNative?: boolean } | undefined
let requested: { binding: DesktopBinding; token: string } | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
const observations = new Map<string, DesktopObservationDto>()

setDesktopReleaseHook((lane, reason) => stopDesktopForLane(lane, reason))

export function setDesktopEngineResolver(resolve: typeof engineForControl): void { engineForControl = resolve }
export function assertDesktopChatEngine(lane: string, engine: DesktopEngine | undefined): void {
  if (!desktopBinding(lane)?.readable) return
  const held = active?.binding.lane === lane ? active : undefined
  if (engine?.desktopToolIsolation === true && (!held || held.engineId === engine.id)) return
  stopDesktopForLane(lane, DESKTOP_TOOL_ISOLATION_MESSAGE)
  throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
}

export function desktopControlStatus(): DesktopControlStatusDto {
  const state = lease.state()
  return state.state === 'running' && !active?.native ? { ...state, state: 'ready' } : state
}

export function stopDesktopControl(reason = 'You stopped computer control.'): void {
  const held = active
  active = undefined
  requested = undefined
  checking = undefined
  clearTimeout(expiry)
  expiry = undefined
  observations.clear()
  lease.stop(reason)
  if (held) {
    held.binding.revision++
    held.binding.readable = false
    if (held.native) void held.binding.host.request('stop', { lease: held.native }).catch(() => held.binding.host.close())
    else if (held.bindingNative) held.binding.host.close()
  }
}

export function stopDesktopFromUi(): void {
  if (lease.state().state === 'paused' && !active && !requested && !checking) lease.reset()
  else stopDesktopControl()
}

export function stopDesktopForLane(lane: string, reason = 'This chat stopped.'): void {
  if (lease.state().lane === lane || active?.binding.lane === lane || checking?.binding.lane === lane) stopDesktopControl(reason)
}

export async function startDesktopControl(lane: string): Promise<DesktopControlStatusDto> {
  const binding = desktopBinding(lane)
  const owner = desktopOwner()
  if (!binding || !owner) throw new Error('Choose an app window before allowing control.')
  if (binding.stopped || binding.host.closed) throw new Error('This app connection ended. Reconnect the app window to continue.')
  if (checking) throw new Error('Computer control is already pending or running.')
  const check = { binding }
  checking = check
  let token: string | undefined
  try {
    const engine = await engineForControl()
    if (checking !== check || desktopBinding(lane) !== binding || desktopOwner() !== owner || binding.stopped || binding.host.closed) throw new Error('This control request was cancelled.')
    if (engine?.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
    token = lease.reserve(lane, binding.name)
    requested = { binding, token }
    checking = undefined
    const revision = ++binding.revision
    const answer = await dialog.showMessageBox(owner, {
      type: 'question', title: 'Computer control', message: `Allow this chat to control ${binding.name}?`,
      detail: 'Engram may bring this window forward, move the pointer, click, scroll, and type. Text and screenshots from this window may be sent to your connected AI. This uses your real desktop, not a separate background computer. Move your mouse, press a key, or use Stop to end control. Press Esc to stop immediately. Access is limited to this session and ends when this chat finishes or after 10 minutes. Do not use this for passwords, authentication, or sensitive transactions.',
      buttons: ['Cancel', 'Allow for this session'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (answer.response !== 1) throw new Error('Computer control was not allowed.')
    const currentEngine = await engineForControl()
    if (currentEngine?.desktopToolIsolation !== true || currentEngine.id !== engine.id) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
    if (requested?.token !== token || desktopBinding(lane) !== binding || revision !== binding.revision || desktopOwner() !== owner || lease.state().state !== 'needs-person') throw new Error('This control request was cancelled.')
    active = { binding, token, engineId: engine.id, nativeGrant: randomUUID() }
    lease.activate(token)
    requested = undefined
    binding.readable = true
    binding.stopped = false
    expiry = setTimeout(() => stopDesktopControl('Computer control expired. Allow it again to continue.'), 10 * 60_000)
    expiry.unref()
    desktopChanged()
    return desktopControlStatus()
  } catch (error) {
    if (checking === check) checking = undefined
    if (token && (active?.token === token || requested?.token === token)) stopDesktopControl(error instanceof Error ? error.message : 'Computer control did not start.')
    throw error
  }
}

async function beginNative(held: NonNullable<typeof active>): Promise<void> {
  lease.assertActive(held.token, held.binding.lane)
  if (held.native) return
  held.bindingNative = true
  try {
    const result = await held.binding.host.request<{ lease: string }>('bind', { window: held.binding.window, pid: held.binding.pid, grant: held.nativeGrant })
    lease.assertActive(held.token, held.binding.lane)
    if (active !== held || !result?.lease) throw new Error('Computer control was cancelled before it started.')
    held.native = result.lease
    desktopChanged()
  } finally { held.bindingNative = false }
}

async function readBoundDesktop(lane: string, signal?: AbortSignal, agent = false): Promise<DesktopObservationDto> {
  signal?.throwIfAborted()
  const binding = desktopBinding(lane)
  if (!binding?.readable) throw new Error('Allow AI read access for this window first.')
  const revision = binding.revision
  const held = active?.binding === binding ? active : undefined
  const read = async () => {
    if (agent && held) await beginNative(held)
    return binding.host.request<DesktopObservationDto>('observe', {
      window: binding.window, pid: binding.pid, ...(held?.native ? { lease: held.native } : {}),
    })
  }
  const result = agent && held ? await lease.run(held.token, lane, read) : await read()
  signal?.throwIfAborted()
  if (desktopBinding(lane) !== binding || !binding.readable || binding.revision !== revision) throw new Error('AI access ended while reading the window.')
  if (!result || typeof result.snapshot !== 'string' || !Array.isArray(result.nodes) || !result.bounds || ![result.bounds.x, result.bounds.y, result.bounds.width, result.bounds.height].every(Number.isFinite) || result.bounds.width <= 0 || result.bounds.height <= 0) throw new Error('This app did not provide a valid observation.')
  observations.set(lane, result)
  return result
}

export async function readControlledDesktop(lane: string, signal?: AbortSignal, agent = false): Promise<DesktopObservationDto> {
  const token = active?.binding.lane === lane ? active.token : undefined
  const stop = () => { if (token && active?.token === token) stopDesktopForLane(lane, 'This chat was cancelled.') }
  if (agent) signal?.addEventListener('abort', stop, { once: true })
  try { return await readBoundDesktop(lane, signal, agent) }
  catch (error) {
    if (agent && token && active?.token === token) stopDesktopForLane(lane, 'The selected app could not be observed safely.')
    throw error
  } finally { signal?.removeEventListener('abort', stop) }
}

export async function actOnDesktop(lane: string, action: DesktopAction, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const held = active
  const token = lease.tokenFor(lane)
  if (!held?.native || !token || held.token !== token || held.binding.lane !== lane) throw new Error('Computer control is not active. The person must click Allow control in Engram to start it; do not try another route.')
  const observation = observations.get(lane)
  if (!observation || observation.snapshot !== action.snapshot) throw new Error('Observe the selected app again before acting. This snapshot is stale.')
  observations.delete(lane)
  const stop = () => { if (active?.token === token) stopDesktopForLane(lane, 'This chat was cancelled.') }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    return await lease.run(token, lane, async () => {
      signal?.throwIfAborted()
      const base = { window: held.binding.window, pid: held.binding.pid, lease: held.native, snapshot: action.snapshot }
      const args: Record<string, unknown> = { ...base }
      if (action.kind === 'click') {
        if ('element' in action) args['element'] = action.element
        else {
          const bounds = observation.captureBounds
          if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('Observe an app with verified client coordinates before clicking by position.')
          args['x'] = Math.round(bounds.x + action.x * (bounds.width - 1))
          args['y'] = Math.round(bounds.y + action.y * (bounds.height - 1))
        }
      } else if (action.kind === 'type') args['text'] = action.text
      else if (action.kind === 'scroll') args['delta'] = action.delta
      else args['key'] = action.key
      await held.binding.host.request(action.kind, args)
      signal?.throwIfAborted()
      return 'Input was dispatched to the selected app. Observe it again to verify the outcome before claiming success or taking another action.'
    })
  } catch (error) {
    if (active?.token === token) stopDesktopForLane(lane, 'Computer control stopped after an action could not be verified.')
    throw error
  } finally { signal?.removeEventListener('abort', stop) }
}
