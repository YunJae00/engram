import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopGuardedAction } from 'core'
import type { DesktopObservationDto } from '../src/shared/desktop.js'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.js'

const target = { name: 'Draft', controlType: 'Edit' }
const next = { name: 'Continue', controlType: 'Button' }
const base = (): DesktopObservationDto => ({ snapshot: 'first', truncated: false, captureSafe: true,
  bounds: { x: 0, y: 0, width: 500, height: 400 }, focusedControl: 'draft', focusedEditable: true,
  nodes: [{ id: 'e1', runtimeId: 'draft', ...target, value: '', actions: { type: true }, bounds: { x: 10, y: 10, width: 300, height: 30 } }] })
const step = (action: Omit<DesktopGuardedAction, 'snapshot' | 'target'> & { text?: string; key?: string; value?: string }, one = target) => ({ ...action, snapshot: 'first', target: one } as DesktopGuardedAction)
afterEach(() => vi.restoreAllMocks())

it('edits and verifies an anchored partial view despite repeated names and renumbered element IDs', async () => {
  const original = base()
  original.truncated = true
  original.nodes.push({ ...original.nodes[0]!, id: 'e2', runtimeId: 'other' })
  const current = structuredClone(original)
  current.nodes[0]!.id = 'e9'
  const act = vi.fn(async (action) => { if (action.kind === 'type') current.nodes[0]!.value = action.text })
  const anchored = { ...target, element: 'e1' }
  const result = JSON.parse(await guardedSequence(original, [step({ kind: 'click' }, anchored), step({ kind: 'type', text: 'Checked' }, anchored), step({ kind: 'verify', value: 'Checked' }, anchored)], async () => current, act))
  expect(result).toMatchObject({ completed: 3, dispatched: 2, verified: 1 })
  expect(act.mock.calls[0]![0]).toEqual({ kind: 'click', snapshot: 'first', element: 'e9' })
  expect(current.nodes[1]!.value).toBe('')
})

it.each(['unseen', 'name', 'identity', 'password', 'unsafe', 'focus', 'mixed'] as const)('refuses an unsafe partial anchor: %s', async (change) => {
  const original = base()
  original.truncated = true
  const current = structuredClone(original)
  const anchored = { ...target, element: change === 'unseen' ? 'e99' : 'e1' }
  if (change === 'name') anchored.name = 'Different'
  if (change === 'identity') current.nodes[0]!.runtimeId = 'replacement'
  if (change === 'password') current.nodes[0]!.password = true
  if (change === 'unsafe') current.captureSafe = false
  if (change === 'focus') current.focusedControl = 'other'
  const actions = [step({ kind: 'type', text: 'Do not type' }, anchored)]
  if (change === 'mixed') actions.push(step({ kind: 'verify', value: 'Do not type' }))
  const act = vi.fn()
  const result = JSON.parse(await guardedSequence(original, actions, async () => current, act))
  expect(result.error).toBeTruthy()
  expect(act).not.toHaveBeenCalled()
})

it('stops after focus changes within an anchored batch without repeating delivered input', async () => {
  const original = base()
  original.truncated = true
  const current = structuredClone(original)
  const act = vi.fn(async () => { current.focusedControl = 'different' })
  const anchored = { ...target, element: 'e1' }
  const result = JSON.parse(await guardedSequence(original, [step({ kind: 'key', key: 'Tab' }, anchored), step({ kind: 'type', text: 'Do not type' }, anchored)], async () => current, act))
  expect(result).toMatchObject({ completed: 1, dispatched: 1, failedStep: 2 })
  expect(result.error).toContain('focus')
  expect(act).toHaveBeenCalledOnce()
})

it('verifies multiline values across native line endings without sending input', async () => {
  const current = base()
  current.nodes[0]!.value = 'First\r\nSecond\tValue'
  const act = vi.fn()
  const result = JSON.parse(await guardedSequence(current, [step({ kind: 'verify', value: 'First\nSecond\tValue' })], async () => current, act))
  expect(result).toMatchObject({ verified: 1, dispatched: 0 })
  expect(act).not.toHaveBeenCalled()
})

it('continues through an expected layout transition and verifies without another model call', async () => {
  const current = base()
  const act = vi.fn(async (action) => {
    if (action.kind === 'type') {
      current.nodes[0]!.value = action.text
      current.nodes.push({ id: 'e8', runtimeId: 'next', ...next, bounds: { x: 350, y: 10, width: 70, height: 30 } })
    }
  })
  const read = vi.fn(async () => ({ ...current, snapshot: 'fresh' }))
  const result = JSON.parse(await guardedSequence(base(), [step({ kind: 'type', text: 'Ready' }), step({ kind: 'verify', value: 'Ready' }), step({ kind: 'click' }, next)], read, act))
  expect(result).toMatchObject({ completed: 3, dispatched: 2, verified: 1, requiresVerification: true })
  expect(act.mock.calls[1]![0]).toEqual({ kind: 'click', snapshot: 'fresh', element: 'e8' })
  expect(read).toHaveBeenCalledTimes(3)
})

it('waits for delayed readback without repeating input', async () => {
  const current = base()
  let reads = 0
  const read = vi.fn(async () => { if (++reads === 3) current.nodes[0]!.value = 'Complete'; return current })
  const act = vi.fn(async () => undefined)
  const result = JSON.parse(await guardedSequence(base(), [step({ kind: 'type', text: 'Complete' }), step({ kind: 'verify', value: 'Complete' })], read, act))
  expect(result.verified).toBe(1)
  expect(act).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledTimes(3)
})

it.each(['partial', 'protected', 'geometry', 'ambiguous', 'missing', 'focus', 'readonly', 'replaced'] as const)('refuses a changed %s before input', async (change) => {
  const current = base()
  if (change === 'partial') current.truncated = true
  if (change === 'protected') current.protectedBounds = [current.bounds]
  if (change === 'geometry') current.bounds.width++
  if (change === 'ambiguous') current.nodes.push({ ...current.nodes[0]!, id: 'e2', runtimeId: 'other' })
  if (change === 'missing') current.nodes = []
  if (change === 'focus') current.focusedControl = 'other'
  if (change === 'readonly') current.focusedEditable = false
  if (change === 'replaced') current.nodes[0]!.runtimeId = 'other'
  const act = vi.fn()
  const result = JSON.parse(await guardedSequence(base(), [step({ kind: 'type', text: 'Test' })], async () => current, act))
  expect(result.error).toBeTruthy()
  expect(act).not.toHaveBeenCalled()
})

it('stops on a result mismatch and returns fresh evidence without dispatching the remainder', async () => {
  const now = vi.spyOn(performance, 'now')
  let elapsed = 0
  now.mockImplementation(() => (elapsed += 500))
  const act = vi.fn()
  const result = JSON.parse(await guardedSequence(base(), [step({ kind: 'verify', value: 'Never arrived' }), step({ kind: 'type', text: 'Do not type' })], async () => base(), act))
  expect(result).toMatchObject({ completed: 0, verified: 0, observationMayBeStale: false })
  expect(result.error).toContain('not observed')
  expect(act).not.toHaveBeenCalled()
})

it('never treats a truncated value prefix as a completed result', async () => {
  let elapsed = 0
  vi.spyOn(performance, 'now').mockImplementation(() => (elapsed += 500))
  const current = base()
  current.nodes[0]!.value = 'Expected'
  current.nodes[0]!.valueTruncated = true
  const act = vi.fn()
  const result = JSON.parse(await guardedSequence(current, [step({ kind: 'verify', value: 'Expected' }), step({ kind: 'type', text: 'Do not type' })], async () => current, act))
  expect(result).toMatchObject({ completed: 0, verified: 0 })
  expect(result.error).toContain('not observed')
  expect(act).not.toHaveBeenCalled()
})

it('reports uncertain delivery without retrying and propagates cancellation', async () => {
  const act = vi.fn(async () => { throw new Error('Native input failed') })
  const result = JSON.parse(await guardedSequence(base(), [step({ kind: 'type', text: 'Test' })], async () => base(), act))
  expect(result).toMatchObject({ error: 'Native input failed', dispatched: 0, observationMayBeStale: true })
  expect(act).toHaveBeenCalledOnce()
  const abort = new AbortController()
  const cancel = vi.fn(async () => { abort.abort(); return base() })
  await expect(guardedSequence(base(), [step({ kind: 'type', text: 'Test' })], cancel, act, abort.signal)).rejects.toThrow()
  expect(act).toHaveBeenCalledOnce()
})
