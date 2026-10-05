import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'

vi.mock('electron', () => ({ nativeImage: {} }))
import { maskedFrame } from '../src/main/masked-frame.js'
import { SECRET_FIELDS } from '../src/main/page-mask.js'

afterEach(() => { vi.useRealTimers() })

it.each(['cc-number', 'cc-csc', 'cc-exp', 'one-time-code', 'current-password', 'new-password'])('masks %s as an autocomplete token, including section-prefixed and uppercase values', token => {
  expect(SECRET_FIELDS).toContain(`[autocomplete~="${token}" i]`)
})

it.each(['none', 'navigation', 'same-url reload', 'attach', 'replace frame', 'abort'])('rejects a screenshot whose source changed during capture (%s)', async change => {
  const events = new EventEmitter(), controller = new AbortController()
  let url = 'https://example.test/issue'
  const frame = { url: () => url, isDetached: () => false, locator: (selector: string) => ({ selector, count: async () => 1 }) }
  let frames = [frame]
  const screenshot = vi.fn<(options: unknown) => Promise<Buffer>>(async () => {
    if (change === 'navigation') url = 'https://example.test/login'
    if (change === 'same-url reload') events.emit('framenavigated', frame)
    if (change === 'attach') { frames = [frame, { ...frame }]; events.emit('frameattached', frames[1]) }
    if (change === 'replace frame') frames = [{ ...frame }]
    if (change === 'abort') controller.abort()
    return Buffer.from('masked image')
  })
  const page = { url: () => url, frames: () => frames, isClosed: () => false, screenshot, on: events.on.bind(events), off: events.off.bind(events) } as unknown as Page
  const result = maskedFrame(page, 'https://example.test', [], controller.signal)
  if (change === 'none') {
    await expect(result).resolves.toEqual(Buffer.from('masked image'))
    expect(screenshot.mock.calls[0]?.[0]).toMatchObject({ mask: [{ selector: SECRET_FIELDS }] })
  } else await expect(result).rejects.toThrow()
  expect(events.eventNames()).toEqual([])
})

it.each(['abort', 'timeout'])('bounds a stuck frame inspection without taking a screenshot (%s)', async how => {
  vi.useFakeTimers()
  const events = new EventEmitter(), controller = new AbortController()
  const screenshot = vi.fn()
  const frame = { url: () => 'https://example.test/issue', locator: () => ({ count: () => new Promise(() => {}) }) }
  const page = { url: frame.url, frames: () => [frame], isClosed: () => false, screenshot, on: events.on.bind(events), off: events.off.bind(events) } as unknown as Page
  const checked = expect(maskedFrame(page, 'https://example.test', [], controller.signal)).rejects.toThrow(/canceled|timed out/)
  if (how === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(8000)
  await checked
  expect(screenshot).not.toHaveBeenCalled()
  expect(events.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
