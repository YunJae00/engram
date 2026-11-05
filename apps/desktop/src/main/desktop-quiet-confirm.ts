import { createHash } from 'node:crypto'
import type { QuietControlDto, QuietObservationDto, QuietPressResultDto } from '../shared/desktop.js'
import type { QuietPressOptions } from 'core'
import { quietPress, quietScan } from './desktop-quiet.js'
import { desktopFailure } from './desktop-failure.js'
import { flog } from './flog.js'

type Identity = { runtimeId?: string; type: string; name: string; path: string }
type Field = 'window' | 'pid' | 'control' | 'enabled' | 'name' | 'value'
export interface QuietConfirmation {
  before: QuietObservationDto
  target: Identity
  editors: { identity: Identity; value: string | null | undefined }[]
  scope: string
}
const identity = (view: QuietObservationDto, control: QuietControlDto): Identity => {
  const path: string[] = []
  let parent = control.parent
  const seen = new Set<string>()
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const node = view.controls.find(item => item.id === parent)
    if (!node) { path.push('?'); break }
    path.push(JSON.stringify([node.type, node.name]))
    parent = node.parent
  }
  return { runtimeId: control.runtimeId, type: control.type, name: control.name, path: control.runtimeId ? '' : path.join('/') }
}
function locate(view: QuietObservationDto, wanted: Identity): QuietControlDto | undefined {
  if (!wanted.runtimeId && wanted.path.split('/').includes('?')) return undefined
  const matches = view.controls.filter(control => wanted.runtimeId
    ? control.runtimeId === wanted.runtimeId
    : control.type === wanted.type && control.name === wanted.name && identity(view, control).path === wanted.path)
  return matches.length === 1 ? matches[0] : undefined
}
const mismatch = (field: Field): void => { flog('harness', JSON.stringify({ kind: 'host', operation: 'confirm-mismatch', field })) }
export const confirmationFailure = () => ({ ...desktopFailure('This snapshot is stale. No input was sent.'), retry: 'unsafe' as const, hint: 'No input was sent. Stop this action; do not request approval again.' })

export async function prepareQuietConfirmation(lane: string, app: string, before: QuietObservationDto, id: string, sending: boolean, signal?: AbortSignal): Promise<QuietConfirmation | undefined> {
  const control = before.controls.find(item => item.id === id)
  if (!control) { mismatch('control'); return undefined }
  let editorView = before
  if (sending && !before.controls.some(item => item.can.set && !item.secret)) {
    editorView = await quietScan(lane, app, undefined, signal)
    if (editorView.window !== before.window || editorView.pid !== before.pid) { mismatch(editorView.window !== before.window ? 'window' : 'pid'); return undefined }
  }
  const editors = sending ? editorView.controls.filter(item => item.can.set && !item.secret).map(item => ({ identity: identity(editorView, item), value: item.value })) : []
  if (sending && (!editors.length || editors.some(item => item.value === undefined || item.value === null || item.value.endsWith('…') || item.value.length >= 20_000))) { mismatch('value'); return undefined }
  const target = identity(before, control)
  const scope = createHash('sha256').update(JSON.stringify([before.window, before.pid, target, [...editors].sort((a, b) => JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)))])).digest('hex')
  return { before, target, editors, scope }
}

export function checkQuietConfirmation(approval: QuietConfirmation, current: QuietObservationDto, editorViews: QuietObservationDto[] = [current], failed?: (field: Field) => void): QuietControlDto | undefined {
  let field: Field | undefined
  const target = locate(current, approval.target)
  if (current.window !== approval.before.window || editorViews.some(view => view.window !== approval.before.window)) field = 'window'
  else if (current.pid !== approval.before.pid || editorViews.some(view => view.pid !== approval.before.pid)) field = 'pid'
  else if (approval.editors.some((editor, i) => {
    const found = locate(editorViews[i] ?? current, editor.identity)
    return !found || found.secret || found.type !== editor.identity.type || found.name !== editor.identity.name || !found.enabled || found.value !== editor.value
  })) field = 'value'
  else if (!target || target.type !== approval.target.type || target.secret) field = 'control'
  else if (!target.enabled) field = 'enabled'
  else if (target.name !== approval.target.name) field = 'name'
  if (field) { mismatch(field); failed?.(field); return undefined }
  return target
}

export async function pressQuietConfirmed(lane: string, app: string, approval: QuietConfirmation, signal?: AbortSignal, options?: QuietPressOptions): Promise<QuietPressResultDto> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await quietScan(lane, app, approval.before.find ?? (approval.target.name || undefined), signal)
    // One scan at a time: the helper keeps per-window snapshot state that concurrent reads would race.
    const editors: QuietObservationDto[] = []
    for (const editor of approval.editors) editors.push(await quietScan(lane, app, editor.identity.name || undefined, signal))
    let failed: Field | undefined
    const target = checkQuietConfirmation(approval, current, editors, field => { failed = field })
    if (!target) {
      if (failed && ['window', 'pid', 'name', 'value'].includes(failed)) break
      continue
    }
    try { return await quietPress(lane, app, current.snapshot, target.id, signal, options) }
    catch (error) {
      signal?.throwIfAborted()
      const failure = desktopFailure(error)
      if (failure.error !== 'stale_snapshot' || failure.delivery !== 'not_delivered') throw error
      mismatch('control')
    }
  }
  throw new Error('This snapshot is stale. No input was sent.')
}
