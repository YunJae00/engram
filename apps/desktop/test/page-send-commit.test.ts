import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { pressKey, pressOn } from '../src/main/page-actions.js'
import { inspectControl } from '../src/main/page-target.js'

function editablePage(overrides = {}) {
  let focused = true
  const control = { words: 'Message', editable: true, multiline: true, field: true, secret: false, posts: false, submits: false, ...overrides }
  const hand = { contentFrame: async () => null, evaluate: vi.fn(async (fn: unknown) => fn === inspectControl ? control : focused), press: vi.fn(async () => {}) }
  const active = { asElement: () => hand, dispose: vi.fn(async () => {}) }
  const page = { evaluate: async () => 'signature', url: () => 'https://chat.test', mainFrame: () => ({ evaluateHandle: async () => active }), waitForLoadState: async () => {}, waitForTimeout: async () => {} } as unknown as Page
  return { page, hand, blur: () => { focused = false } }
}

it('refuses contenteditable Enter without approval', async () => {
  const { page, hand } = editablePage()
  expect(await pressKey(page, 'Enter')).toMatchObject({ ok: false, refused: expect.any(String) })
  expect(hand.press).not.toHaveBeenCalled()
})

it('records an approved Enter as committed even if dispatch times out', async () => {
  const { page, hand } = editablePage()
  hand.press.mockRejectedValue(new Error('Timed out after dispatch'))
  expect(await pressKey(page, 'Enter', undefined, async () => 'approve')).toMatchObject({ ok: false, committed: true })
  expect(hand.press).toHaveBeenCalledTimes(1)
})

it('rechecks focus after approval before sending', async () => {
  const { page, hand, blur } = editablePage()
  expect(await pressKey(page, 'Enter', undefined, async () => { blur(); return 'approve' })).toMatchObject({ ok: false, error: expect.stringContaining('changed') })
  expect(hand.press).not.toHaveBeenCalled()
})

it('does not click 보내기 without approval', async () => {
  const hand = { filter: () => hand, first: () => hand, count: async () => 1, evaluate: async () => ({ words: '보내기', submits: false }), click: vi.fn() }
  const page = { frames: () => [], mainFrame: () => null, ...Object.fromEntries(['getByRole', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText', 'getByText', 'locator'].map(name => [name, () => hand])) } as unknown as Page
  expect(await pressOn(page, '보내기')).toMatchObject({ ok: false, refused: '보내기' })
  expect(hand.click).not.toHaveBeenCalled()
})

it('requests approval for textarea Enter', async () => {
  const { page, hand } = editablePage({ multiline: true })
  const ask = vi.fn(async () => 'approve' as const)
  expect(await pressKey(page, 'Enter', undefined, ask)).toMatchObject({ ok: true, committed: true })
  expect(ask).toHaveBeenCalledOnce()
  expect(hand.press).toHaveBeenCalledExactlyOnceWith('Enter', expect.any(Object))
})
it('presses Enter in a single-line input outside a form without approval', async () => {
  const { page, hand } = editablePage({ multiline: false })
  const ask = vi.fn(async () => 'approve' as const)
  expect(await pressKey(page, 'Enter', undefined, ask)).toMatchObject({ ok: true })
  expect(ask).not.toHaveBeenCalled()
  expect(hand.press).toHaveBeenCalledOnce()
})
it('keeps approval for Enter in a single-line input in a posting form with a submit control', async () => {
  const { page, hand } = editablePage({ multiline: false, posts: true, submits: false })
  expect(await pressKey(page, 'Enter')).toMatchObject({ ok: false, refused: expect.any(String) })
  expect(hand.press).not.toHaveBeenCalled()
  const ask = vi.fn(async () => 'approve' as const)
  expect(await pressKey(page, 'Enter', undefined, ask)).toMatchObject({ ok: true, committed: true })
  expect(ask).toHaveBeenCalledOnce()
})

it('keeps Space available in a single-line field while checking its Enter commit label', async () => {
  const { page, hand } = editablePage({ words: 'Submit', multiline: false })
  expect(await pressKey(page, 'Space')).toMatchObject({ ok: true })
  expect(await pressKey(page, 'Enter')).toMatchObject({ ok: false, refused: expect.any(String) })
  expect(hand.press).toHaveBeenCalledTimes(1)
})
