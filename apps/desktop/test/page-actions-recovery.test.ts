import { expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { pressOn, pressPoint, scrollPage } from '../src/main/page-actions.js'
import { readFrames, type FrameReading } from '../src/main/page-reader.js'

function pointerPage(size: unknown, evaluated: unknown = undefined) {
  const mouse = { click: vi.fn(), move: vi.fn(), wheel: vi.fn() }
  const frame = { evaluate: vi.fn().mockResolvedValue(undefined) }
  const evaluate = vi.fn().mockResolvedValue(evaluated)
  const page = {
    viewportSize: () => size, evaluate,
    evaluateHandle: async () => ({ asElement: () => ({ evaluate }), dispose: async () => {} }),
    frames: () => [frame], mainFrame: () => frame, mouse,
    waitForLoadState: vi.fn().mockResolvedValue(undefined), waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page
  return { page, mouse, frame }
}

it.each([undefined, null, { width: 0, height: 600 }, { width: 800 }, { width: 800, height: Number.NaN }, { width: Infinity, height: 600 }])('does not guess coordinates from an invalid viewport: %j', async size => {
  const { page, mouse } = pointerPage(size)
  for (const result of [await pressPoint(page, 0.5, 0.5), await scrollPage(page, 'down')]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('viewport is unavailable') })
    expect(result.error).toContain('read_open_page or look')
  }
  expect(mouse.click).not.toHaveBeenCalled()
  expect(mouse.move).not.toHaveBeenCalled()
  expect(mouse.wheel).not.toHaveBeenCalled()
})

it('handles a detached viewport read without a TypeError or input', async () => {
  const { page, mouse } = pointerPage(null)
  vi.mocked(page.evaluate).mockRejectedValue(new Error('frame detached'))
  expect((await pressPoint(page, 0.5, 0.5)).error).toContain('viewport is unavailable')
  expect((await scrollPage(page, 'down')).error).toContain('viewport is unavailable')
  expect(mouse.click).not.toHaveBeenCalled()
  expect(mouse.wheel).not.toHaveBeenCalled()
})

it('accepts observed dimensions but still inspects and refuses a committing point', async () => {
  const { page, mouse } = pointerPage(null)
  vi.mocked(page.evaluate).mockResolvedValueOnce({ width: 800, height: 600 }).mockResolvedValueOnce({ words: 'Submit', submits: true })
  expect(await pressPoint(page, 0.5, 0.5)).toMatchObject({ ok: false, refused: 'Submit' })
  expect(mouse.click).not.toHaveBeenCalled()
})

it('uses valid observed dimensions for exactly one inspected click', async () => {
  const { page, mouse } = pointerPage(null)
  vi.mocked(page.evaluate).mockResolvedValueOnce({ width: 800, height: 600 }).mockResolvedValueOnce({ words: 'Details', submits: false })
    .mockResolvedValueOnce('before').mockResolvedValueOnce('after')
  expect(await pressPoint(page, 0.5, 0.5)).toEqual({ ok: true, changed: true })
  expect(mouse.click).toHaveBeenCalledExactlyOnceWith(400, 300)
})

it('does not require guessed dimensions for a confirmed DOM scroll result', async () => {
  const { page, mouse, frame } = pointerPage(null)
  frame.evaluate.mockResolvedValue(false)
  expect(await scrollPage(page, 'down')).toEqual({ ok: true, changed: false })
  expect(mouse.wheel).not.toHaveBeenCalled()
})

it('does not mistake an undefined frame scroll result for success', async () => {
  const { page, mouse, frame } = pointerPage({ width: 800, height: 600 })
  expect(await scrollPage(page, 'down')).toEqual({ ok: true })
  expect(frame.evaluate).toHaveBeenCalledTimes(1)
  expect(mouse.move).toHaveBeenCalledWith(400, 300)
  expect(mouse.wheel).toHaveBeenCalledWith(0, 480)
})

it.each(['changed', 'undefined', 'malformed'])('rejects an observed control number when its next frame read is %s', async mode => {
  const reading = (name: string): FrameReading => ({ text: name, hidden: '', hasPasswordField: false, links: [], controls: [{ kind: 'button', name, state: '' }], dialog: '', faults: [] })
  const frame = { evaluate: vi.fn().mockResolvedValueOnce(reading('Old')).mockResolvedValue(mode === 'changed' ? reading('New') : mode === 'undefined' ? undefined : {}), locator: vi.fn(), name: () => '', url: () => 'https://example.test' }
  const page = { on: vi.fn(), frames: () => [frame], mainFrame: () => frame } as unknown as Page
  await readFrames(page)
  expect(await pressOn(page, '#1')).toMatchObject({ ok: false, error: expect.stringContaining('no longer matches') })
  expect(frame.locator).not.toHaveBeenCalled()
})
