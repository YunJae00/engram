import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'
import { clickSettled, NO_EFFECT, observationKey, scrollPages, settle, STILL_CHANGING } from '../src/main/desktop-settle.js'

const view = (snapshot: string, y = 20, extra: Partial<DesktopObservationDto> = {}): DesktopObservationDto => ({
  snapshot, truncated: false, bounds: { x: 0, y: 0, width: 400, height: 500 },
  nodes: [{ id: `${snapshot}-b`, runtimeId: 'go', name: 'Go', controlType: 'Button', bounds: { x: 10, y, width: 40, height: 30 } },
    { id: `${snapshot}-s`, name: 'Status', controlType: 'Text', value: 'Idle' }], ...extra,
})
const reads = (...views: DesktopObservationDto[]) => { const read = vi.fn(); for (const one of views) read.mockResolvedValueOnce(one); read.mockResolvedValue(views.at(-1)); return read }
const key = (value: string) => value
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('waits until two reads match', async () => {
  const read = vi.fn().mockResolvedValueOnce('A').mockResolvedValue('B')
  const pending = settle(read, key)
  await vi.advanceTimersByTimeAsync(300)
  await expect(pending).resolves.toEqual({ view: 'B', settled: true })
  expect(read).toHaveBeenCalledTimes(3)
  const still = vi.fn().mockResolvedValue('S')
  const quick = settle(still, key)
  await vi.advanceTimersByTimeAsync(200)
  await expect(quick).resolves.toEqual({ view: 'S', settled: true })
  expect(still).toHaveBeenCalledTimes(2)
  // The view the action was planned on never counts: a change that starts after the first poll is still waited for.
  const late = vi.fn().mockResolvedValueOnce('A').mockResolvedValue('B')
  const delayed = settle(late, key)
  await vi.advanceTimersByTimeAsync(400)
  await expect(delayed).resolves.toEqual({ view: 'B', settled: true })
  expect(late).toHaveBeenCalledTimes(3)
  const controller = new AbortController()
  const cancelled = settle(vi.fn().mockResolvedValue('C'), key, { signal: controller.signal })
  const rejection = expect(cancelled).rejects.toThrow()
  controller.abort()
  await vi.advanceTimersByTimeAsync(100)
  await rejection
  const moved = view('m', 20, { bounds: { x: 5, y: 0, width: 400, height: 500 } })
  expect(observationKey(moved)).not.toBe(observationKey(view('n')))
})

it('gives up and says it is still moving', async () => {
  let count = 0
  const read = vi.fn(async () => `frame ${++count}`)
  const pending = settle(read, key)
  await vi.advanceTimersByTimeAsync(1600)
  await expect(pending).resolves.toEqual({ view: `frame ${count}`, settled: false })
  let frame = 0
  const click = vi.fn(async () => undefined)
  const moving = clickSettled({ views: [view('a')], element: 'a-b', read: async () => view(`r${++frame}`, 20 + frame), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(2000)
  await expect(moving).resolves.toMatchObject({ settled: false, clicks: 1, message: STILL_CHANGING })
  expect(click).toHaveBeenCalledOnce()
})

it('retries a missed click once only', async () => {
  const click = vi.fn(async () => undefined)
  const missedRead = reads(view('r'))
  const missed = clickSettled({ views: [view('a')], element: 'a-b', read: missedRead, click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(missed).resolves.toMatchObject({ clicks: 2, effect: false, retried: true, message: NO_EFFECT })
  expect(click.mock.calls[1]![1]).toBe('r-b')
  expect(missedRead).toHaveBeenCalledTimes(8)

  click.mockClear()
  const status = view('s'); status.nodes[1]!.value = 'Busy'
  const unrelated = clickSettled({ views: [view('a')], element: 'a-b', read: reads(status), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(unrelated).resolves.toMatchObject({ clicks: 1, effect: true })

  click.mockClear()
  const editor = { focusedEditable: true, focusedControl: 'go' }
  const focused = clickSettled({ views: [view('a', 20, editor)], element: 'a-b', read: reads(view('r', 20, editor)), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  const kept = await focused
  expect(kept).toMatchObject({ clicks: 1, settled: true })
  expect(kept.message).toBeUndefined()

  click.mockClear()
  const slow = clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('r'), view('r'), view('o', 20, { focusedControl: 'go' })), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(slow).resolves.toMatchObject({ clicks: 1, effect: true, retried: false })

  click.mockClear()
  const send = clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('r')), click, mayRetry: () => false })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(send).resolves.toMatchObject({ clicks: 1, message: NO_EFFECT })

  click.mockClear()
  const opened = view('o', 20, { focusedControl: 'go' })
  const late = clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('r'), opened), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(late).resolves.toMatchObject({ clicks: 1, effect: true })

  click.mockClear()
  const shifting = clickSettled({ views: [view('a', 20), view('b', 60)], element: 'b-b', read: reads(view('c', 90), view('d', 90), view('e', 90, { focusedControl: 'go' })), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(shifting).resolves.toMatchObject({ clicks: 1, effect: true })
  expect(click.mock.calls[0]![1]).toBe('d-b')

  await expect(clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('a')), click: async () => { throw new Error('not sent') }, mayRetry: () => true })).rejects.toThrow('not sent')
  const failing = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('retry failed'))
  const second = clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('r')), click: failing, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(second).resolves.toMatchObject({ clicks: 1, error: expect.any(Error) })
})

it('scrolls one visible page per step', async () => {
  const scroll = vi.fn(async () => undefined)
  const down = scrollPages({ delta: 3, snapshot: 'a', since: view('a', 20), read: reads(view('p1', 0), view('p1', 0), view('p2', -40), view('p2', -40), view('p3', -80)), scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(down).resolves.toMatchObject({ steps: 3, settled: true, reachedEnd: false })
  expect(scroll.mock.calls).toEqual([['a', 1], ['p1', 1], ['p2', 1]])

  scroll.mockClear()
  const up = scrollPages({ delta: -2, snapshot: 'a', since: view('a', 20), read: reads(view('u1', 60), view('u1', 60), view('u2', 100)), scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(up).resolves.toMatchObject({ steps: 2 })
  expect(scroll.mock.calls.map(call => (call as unknown[])[1])).toEqual([-1, -1])

  scroll.mockClear()
  const endRead = reads(view('a2'))
  const end = scrollPages({ delta: 5, snapshot: 'a', since: view('a'), read: endRead, scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(end).resolves.toMatchObject({ steps: 1, reachedEnd: true })
  expect(scroll).toHaveBeenCalledOnce()
  expect(endRead).toHaveBeenCalledTimes(4)

  let frame = 0
  const busy = scrollPages({ delta: 4, snapshot: 'a', read: async () => view(`f${++frame}`, frame), scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(busy).resolves.toMatchObject({ steps: 1, settled: false, message: STILL_CHANGING })
})

it('retries a click whose target only shifted', async () => {
  const click = vi.fn(async () => undefined)
  const shifted = clickSettled({ views: [view('a')], element: 'a-b', read: reads(view('r', 60)), click, mayRetry: () => true })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(shifted).resolves.toMatchObject({ clicks: 2, effect: false, retried: true, message: NO_EFFECT })
})

it('does not settle past the cap', async () => {
  const read = () => new Promise<string>(resolve => setTimeout(() => resolve('same'), 800))
  const slow = settle(read, key)
  await vi.advanceTimersByTimeAsync(3000)
  await expect(slow).resolves.toEqual({ view: 'same', settled: false })
  const fast = settle(vi.fn().mockResolvedValue('same'), key)
  await vi.advanceTimersByTimeAsync(200)
  await expect(fast).resolves.toEqual({ view: 'same', settled: true })
})

it('confirms the end before skipping pages', async () => {
  const scroll = vi.fn(async () => undefined)
  const t0 = Date.now()
  const read = async () => Date.now() - t0 < 250 ? view('a', 20) : view('p1', 0)
  const late = scrollPages({ delta: 2, snapshot: 'a', since: view('a'), read, scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(late).resolves.toMatchObject({ steps: 2, reachedEnd: true })
  expect(scroll).toHaveBeenCalledTimes(2)

  const stuck = scrollPages({ delta: 2, snapshot: 'a', since: view('a'), read: reads(view('a')), scroll })
  await vi.advanceTimersByTimeAsync(3000)
  await expect(stuck).resolves.toMatchObject({ steps: 1, reachedEnd: true })
})
