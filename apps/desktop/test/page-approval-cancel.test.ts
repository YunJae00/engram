import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { pressOn, pressPoint } from '../src/main/page-actions.js'

it('does not click when Stop races a late approval', async () => {
  const controller = new AbortController()
  const click = vi.fn()
  const page = {
    viewportSize: () => ({ width: 800, height: 600 }),
    url: () => 'https://example.test/form',
    evaluate: vi.fn().mockResolvedValue({ words: 'Submit', submits: true }),
    mouse: { click },
  } as unknown as Page
  const result = await pressPoint(page, 0.5, 0.5, async () => { controller.abort(); return 'approve' }, controller.signal)
  expect(result.ok).toBe(false)
  expect(click).not.toHaveBeenCalled()
})

it('does not dispatch a second click when the first click times out after delivery', async () => {
  const dispatchEvent = vi.fn()
  const hand = {
    filter: () => hand, first: () => hand, count: async () => 1,
    evaluate: async () => ({ words: 'Submit', submits: true }),
    scrollIntoViewIfNeeded: async () => {},
    click: vi.fn().mockRejectedValue(new Error('Timed out after dispatch')),
    dispatchEvent,
  }
  const page = {
    frames: () => [], mainFrame: () => null, url: () => 'https://example.test/form',
    evaluate: async () => 'page signature',
    ...Object.fromEntries(['getByRole', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText', 'getByText', 'locator'].map(name => [name, () => hand])),
  } as unknown as Page
  expect((await pressOn(page, 'Submit', undefined, async () => 'approve')).ok).toBe(false)
  expect(hand.click).toHaveBeenCalledTimes(1)
  expect(dispatchEvent).not.toHaveBeenCalled()
})
