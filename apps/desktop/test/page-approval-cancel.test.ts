import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { pressPoint } from '../src/main/page-actions.js'

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
