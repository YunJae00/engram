import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopControlLease, type DesktopAction } from 'core'
import type { DesktopControlStatusDto, DesktopObservationDto } from '../shared/desktop.js'
import { desktopBinding, desktopChanged, desktopOwner, setDesktopReleaseHook, type DesktopBinding } from './desktop-access.js'

const lease = new DesktopControlLease({ onChange: desktopChanged })
let active: { binding: DesktopBinding; token: string; nativeGrant: string; native?: string; bindingNative?: boolean } | undefined
let requested: { binding: DesktopBinding; token: string } | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
const observations = new Map<string, DesktopObservationDto>()

setDesktopReleaseHook((lane, reason) => stopDesktopForLane(lane, reason))

export function desktopControlStatus(): DesktopControlStatusDto {
  const state = lease.state()
  return state.state === 'running' && !active?.native ? { ...state, state: 'ready' } : state
}

export function stopDesktopControl(reason = 'You stopped computer control.'): void {
  const held = active
  active = undefined
  requested = undefined
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
  if (lease.state().state === 'paused' && !active && !requested) lease.reset()
  else stopDesktopControl()
}

export function stopDesktopForLane(lane: string, reason = 'This chat stopped.'): void {
  if (lease.state().lane === lane || active?.binding.lane === lane) stopDesktopControl(reason)
}

export async function startDesktopControl(lane: string): Promise<DesktopControlStatusDto> {
  const binding = desktopBinding(lane)
  const owner = desktopOwner()
  if (!binding || binding.stopped || !owner) throw new Error('Choose an app window before allowing control.')
  const token = lease.reserve(lane, binding.name)
  requested = { binding, token }
  const revision = ++binding.revision
  try {
    const answer = await dialog.showMessageBox(owner, {
      type: 'question', title: 'Computer control', message: `Allow this chat to control ${binding.name}?`,
      detail: 'Engram may bring this window forward, move the pointer, click, scroll, and type. Text and screenshots from this window may be sent to your connected AI. This uses your real desktop, not a separate background computer. Move your mouse, press a key, or use Stop to end control. Press Esc to stop immediately. Access is limited to this session and ends when this chat finishes or after 10 minutes. Do not use this for passwords, authentication, or sensitive transactions.',
      buttons: ['Cancel', 'Allow for this session'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (answer.response !== 1) throw new Error('Computer control was not allowed.')
    if (requested?.token !== token || desktopBinding(lane) !== binding || revision !== binding.revision || desktopOwner() !== owner || lease.state().state !== 'needs-person') throw new Error('This control request was cancelled.')
    active = { binding, token, nativeGrant: randomUUID() }
    lease.activate(token)
    requested = undefined
    binding.readable = true
    binding.stopped = false
    expiry = setTimeout(() => stopDesktopControl('Computer control expired. Allow it again to continue.'), 10 * 60_000)
    expiry.unref()
    desktopChanged()
    return desktopControlStatus()
  } catch (error) {
    if (active?.token === token || requested?.token === token) stopDesktopControl(error instanceof Error ? error.message : 'Computer control did not start.')
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
          args['x'] = Math.round(observation.bounds.x + action.x * (observation.bounds.width - 1))
          args['y'] = Math.round(observation.bounds.y + action.y * (observation.bounds.height - 1))
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
