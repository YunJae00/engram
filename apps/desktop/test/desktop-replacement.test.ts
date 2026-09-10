import { expect, it, vi } from 'vitest'
import type { DesktopAction, DesktopGuardedAction } from 'core'
import type { DesktopObservationDto } from '../src/shared/desktop.js'
import { replacementTarget } from '../src/main/desktop-replacement.js'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.js'

const target = { name: 'Draft', controlType: 'Edit', element: 'e1' }
const view = (): DesktopObservationDto => ({ snapshot: 'first', truncated: false, captureSafe: true,
  bounds: { x: 0, y: 0, width: 500, height: 400 }, focusedControl: 'draft', focusedEditable: true,
  nodes: [{ id: 'e1', runtimeId: 'draft', name: 'Draft', controlType: 'Edit', value: 'Old', valueTruncated: false,
    actions: { type: true, replace: true }, bounds: { x: 10, y: 10, width: 300, height: 30 } }] })
const step = (): DesktopGuardedAction => ({ kind: 'replace', snapshot: 'first', target, expected: 'Old', text: 'New' })

it.each(['expected', 'truncated', 'unknownCompleteness', 'unsupported', 'focus', 'readonly', 'password', 'hidden', 'disabled', 'missing'] as const)(
  'refuses replacement with %s evidence before dispatch', async (change) => {
    const current = view(), node = current.nodes[0]!
    if (change === 'expected') node.value = 'Changed by application'
    if (change === 'truncated') node.valueTruncated = true
    if (change === 'unknownCompleteness') delete node.valueTruncated
    if (change === 'unsupported') node.actions!.replace = false
    if (change === 'focus') current.focusedControl = 'another'
    if (change === 'readonly') current.focusedEditable = false
    if (change === 'password') node.password = true
    if (change === 'hidden') node.offscreen = true
    if (change === 'disabled') node.enabled = false
    if (change === 'missing') current.nodes = []
    expect(() => replacementTarget(current, 'e1', 'Old')).toThrow()
    const act = vi.fn()
    const result = JSON.parse(await guardedSequence(view(), [step()], async () => current, act))
    expect(result.error).toBeTruthy()
    expect(act).not.toHaveBeenCalled()
  },
)

it('replaces a live anchored field and verifies the full fresh result within the same call', async () => {
  const current = view()
  const act = vi.fn(async (action: DesktopAction) => { if (action.kind === 'replace') current.nodes[0]!.value = action.text })
  const read = vi.fn(async () => structuredClone(current))
  const result = JSON.parse(await guardedSequence(view(), [step()], read, act))
  expect(result).toMatchObject({ completed: 1, dispatched: 1, verified: 1, observation: { nodes: [{ value: 'New' }] } })
  expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'replace', snapshot: 'first', element: 'e1', expected: 'Old', text: 'New' })
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['mismatch', 'unavailable'] as const)('does not retry a replacement after %s readback', async (failure) => {
  const current = view()
  const act = vi.fn(async () => undefined)
  const read = vi.fn().mockResolvedValueOnce(current)
  if (failure === 'mismatch') read.mockResolvedValue(current)
  else read.mockRejectedValue(new Error('Readback unavailable'))
  const result = JSON.parse(await guardedSequence(view(), [step(), step()], read, act))
  expect(result).toMatchObject({ completed: 0, dispatched: 1, verified: 0 })
  expect(result.error).toBeTruthy()
  expect(act).toHaveBeenCalledOnce()
})
