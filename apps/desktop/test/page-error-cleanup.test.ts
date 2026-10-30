import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { scrollPage } from '../src/main/page-actions.js'

it('clears hand marks after scroll failure and preserves the full Playwright error', async () => {
  const error = new Error(`Scroll failed: ${'diagnostic '.repeat(100)}`)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const hand = { filter: () => hand, first: () => hand, count: async () => 1, scrollIntoViewIfNeeded: async () => { throw error } }
  const frame = { evaluate: vi.fn(async () => {}) }
  const page = { frames: () => [frame], mainFrame: () => frame, ...Object.fromEntries(['getByRole', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText', 'getByText', 'locator'].map(name => [name, () => hand])) } as unknown as Page
  try {
    expect(await scrollPage(page, 'Target')).toEqual({ ok: false, error: error.message })
    expect(frame.evaluate).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[page-actions]', error)
  } finally { log.mockRestore() }
})
