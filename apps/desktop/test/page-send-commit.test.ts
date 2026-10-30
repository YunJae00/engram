import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { pressKey, pressOn } from '../src/main/page-actions.js'
import { inspectControl } from '../src/main/page-target.js'

function editablePage() {
  let focused = true
  const control = { words: 'Message', editable: true, field: true, secret: false, posts: false, submits: false }
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
