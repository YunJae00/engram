import { afterEach, expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { readWhenReady } from '../src/main/page-ready.js'

afterEach(() => vi.restoreAllMocks())

function clockPage() {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return { waitForTimeout: async (ms: number) => { now += ms } } as unknown as Page
}

it('waits for delayed content rather than returning a blank page', async () => {
  const page = clockPage()
  let reads = 0
  const result = await readWhenReady(page, async () => ({ url: 'https://example.com', title: 'App', text: ++reads < 12 ? '' : 'Report ready' }))
  expect(result.text).toBe('Report ready')
  expect(reads).toBe(12)
})

it('bounds empty page recovery and never declares missing content as a fact', async () => {
  const page = clockPage()
  await expect(readWhenReady(page, async () => ({ url: 'https://example.com', title: 'App', text: '' }))).rejects.toThrow('Do not infer that it is empty')
})

it('preserves a confirmed login wall and respects cancellation', async () => {
  const page = clockPage()
  expect((await readWhenReady(page, async () => ({ url: 'https://example.com', title: 'Login', text: '', wall: 'login' })))).toHaveProperty('wall', 'login')
  await expect(readWhenReady(page, async () => ({ url: '', title: '', text: '' }), AbortSignal.abort())).rejects.toThrow('stopped')
})
