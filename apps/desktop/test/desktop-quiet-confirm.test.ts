import { beforeEach, expect, it, vi } from 'vitest'
import type { QuietControlDto, QuietObservationDto } from '../src/shared/desktop.js'
const fake = vi.hoisted(() => ({ scan: vi.fn(), press: vi.fn(), log: vi.fn() }))
vi.mock('../src/main/desktop-quiet.js', () => ({ quietScan: fake.scan, quietPress: fake.press }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.log }))
import { checkQuietConfirmation, prepareQuietConfirmation, pressQuietConfirmed, confirmationFailure } from '../src/main/desktop-quiet-confirm.js'
const button = (id = 'c0', extra: Partial<QuietControlDto> = {}): QuietControlDto => ({ id, runtimeId: 'send', type: 'Button', name: 'Send', can: { set: false, press: true, text: false }, enabled: true, offscreen: false, focused: false, secret: false, ...extra })
const editor = button('c1', { runtimeId: 'editor', type: 'Edit', name: 'Message', value: 'Hello', can: { set: true, press: false, text: true } })
const view = (controls = [button(), editor], extra: Partial<QuietObservationDto> = {}): QuietObservationDto => ({ window: '7', pid: 70, snapshot: 'original', title: 'Claude', controls, texts: [], skippedControls: 0, skippedTexts: 0, ms: 1, state: { foreground: false, minimized: false, idleMs: 9000 }, ...extra })
beforeEach(() => { vi.resetAllMocks(); fake.press.mockResolvedValue({ pressed: 'invoke', foregroundChanged: false, control: 'c8' }) })

it('confirms a find result against a larger scan and remaps a reused id', async () => {
  const before = view([button()], { find: 'Send' })
  fake.scan.mockResolvedValue(view())
  const approval = (await prepareQuietConfirmation('lane', 'Claude', before, 'c0', true))!
  const current = view([button('c0', { runtimeId: 'document', name: 'Document' }), button('c8'), editor], { snapshot: 'fresh' })
  fake.scan.mockResolvedValue(current)
  await pressQuietConfirmed('lane', 'Claude', approval)
  expect(fake.scan).toHaveBeenCalledWith('lane', 'Claude', 'Send', undefined)
  expect(fake.press).toHaveBeenCalledExactlyOnceWith('lane', 'Claude', 'fresh', 'c8', undefined, undefined)
})

it.each(['window', 'pid', 'control', 'enabled', 'name', 'value'] as const)('rejects changed %s and logs only the field', async field => {
  const approval = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  const current = view()
  if (field === 'window') current.window = 'other'
  if (field === 'pid') current.pid++
  if (field === 'control') current.controls = [editor]
  if (field === 'enabled') current.controls[0] = button('c0', { enabled: false })
  if (field === 'name') current.controls[0] = button('c0', { name: 'Delete' })
  if (field === 'value') current.controls[1] = { ...editor, value: 'private changed draft' }
  expect(checkQuietConfirmation(approval, current)).toBeUndefined()
  expect(fake.log).toHaveBeenLastCalledWith('harness', JSON.stringify({ kind: 'host', operation: 'confirm-mismatch', field }))
  fake.scan.mockResolvedValue(current)
  await expect(pressQuietConfirmed('lane', 'Claude', approval)).rejects.toThrow('No input was sent')
  expect(fake.press).not.toHaveBeenCalled()
})

it('uses type, name and parent path without runtime identity and rejects duplicates', async () => {
  const parent = button('p', { runtimeId: undefined, type: 'Group', name: 'Composer' })
  const before = view([parent, button('c0', { runtimeId: undefined, parent: 'p' })])
  const approval = (await prepareQuietConfirmation('lane', 'Claude', before, 'c0', false))!
  const current = view([{ ...parent, id: 'new-parent' }, button('c8', { runtimeId: undefined, parent: 'new-parent' })])
  expect(checkQuietConfirmation(approval, current)?.id).toBe('c8')
  current.controls.push(button('duplicate', { runtimeId: undefined, parent: 'new-parent' }))
  expect(checkQuietConfirmation(approval, current)).toBeUndefined()
})

it('retries one undelivered stale press without asking again', async () => {
  const approval = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  fake.scan.mockResolvedValue(view([button('c8'), editor], { snapshot: 'fresh' }))
  fake.press.mockRejectedValueOnce(new Error('This snapshot is stale.'))
  await pressQuietConfirmed('lane', 'Claude', approval)
  expect(fake.press).toHaveBeenCalledTimes(2)
  fake.press.mockRejectedValue(new Error('This snapshot is stale.'))
  await expect(pressQuietConfirmed('lane', 'Claude', approval)).rejects.toThrow('No input was sent')
  expect(fake.press).toHaveBeenCalledTimes(4)
  expect(confirmationFailure()).toMatchObject({ error: 'stale_snapshot', delivery: 'not_delivered', retry: 'unsafe' })
})

it('never retries an uncertain delivery', async () => {
  const approval = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  fake.scan.mockResolvedValue(view())
  fake.press.mockRejectedValueOnce(new Error('Receipt timed out after dispatch'))
  await expect(pressQuietConfirmed('lane', 'Claude', approval)).rejects.toThrow('timed out')
  expect(fake.press).toHaveBeenCalledOnce()
})

it('binds the private scope to the control and exact input, ignoring snapshot ids', async () => {
  const first = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  const next = (await prepareQuietConfirmation('lane', 'Claude', view(undefined, { snapshot: 'new' }), 'c0', true))!
  expect(next.scope).toBe(first.scope)
  const changed = (await prepareQuietConfirmation('lane', 'Claude', view([button(), { ...editor, value: 'Changed' }]), 'c0', true))!
  expect(changed.scope).not.toBe(first.scope)
  expect(first.scope).not.toContain('Hello')
})

it('rejects clipped input instead of approving an unverified suffix', async () => {
  for (const value of ['clipped…', 'x'.repeat(20_000)]) {
    expect(await prepareQuietConfirmation('lane', 'Claude', view([button(), { ...editor, value }]), 'c0', true)).toBeUndefined()
  }
})

it('does not retry after observing a changed draft even if it later returns', async () => {
  const approval = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  fake.scan.mockResolvedValueOnce(view()).mockResolvedValueOnce(view([{ ...editor, value: 'Changed' }])).mockResolvedValue(view())
  await expect(pressQuietConfirmed('lane', 'Claude', approval)).rejects.toThrow('No input was sent')
  expect(fake.scan).toHaveBeenCalledTimes(2)
  expect(fake.press).not.toHaveBeenCalled()
})

it('keeps runtime-based approval scopes stable when find omits parent controls', async () => {
  const broad = view([button('group', { runtimeId: 'group', type: 'Group', name: 'Composer' }), button('c0', { parent: 'group' }), editor])
  const full = (await prepareQuietConfirmation('lane', 'Claude', broad, 'c0', true))!
  fake.scan.mockResolvedValue(view())
  const narrow = (await prepareQuietConfirmation('lane', 'Claude', view([button()], { find: 'Send' }), 'c0', true))!
  expect(narrow.scope).toBe(full.scope)
})

it('keeps the scope stable when unchanged editable controls are reordered', async () => {
  const other = { ...editor, id: 'c2', runtimeId: 'subject', name: 'Subject', value: 'Topic' }
  const first = (await prepareQuietConfirmation('lane', 'Claude', view([button(), editor, other]), 'c0', true))!
  const reordered = (await prepareQuietConfirmation('lane', 'Claude', view([other, button(), editor]), 'c0', true))!
  expect(reordered.scope).toBe(first.scope)
})

it('stops on changed input even when the target is temporarily missing', async () => {
  const approval = (await prepareQuietConfirmation('lane', 'Claude', view(), 'c0', true))!
  fake.scan.mockResolvedValueOnce(view([editor])).mockResolvedValueOnce(view([{ ...editor, value: 'Changed' }])).mockResolvedValue(view())
  await expect(pressQuietConfirmed('lane', 'Claude', approval)).rejects.toThrow('No input was sent')
  expect(fake.scan).toHaveBeenCalledTimes(2)
  expect(fake.press).not.toHaveBeenCalled()
})
