import { beforeAll, describe, expect, it } from 'vitest'

type Module = typeof import('../src/renderer/src/components/PreviewCard.js')
let card: Module

beforeAll(async () => {
  const engram = new Proxy({}, { get: () => () => () => undefined })
  Object.assign(globalThis, { window: Object.assign(globalThis, { engram }) })
  card = await import('../src/renderer/src/components/PreviewCard.js')
})

function stageWithCanvas(width: number, height: number) {
  const canvas = { width, height }
  return { canvas, stage: { querySelector: (selector: string) => selector === 'canvas' ? canvas : null } as unknown as ParentNode }
}

function paint(size: ReturnType<Module['recordStageSize']>, id: string, stage: ParentNode) {
  return card.recordStageSize(size, id, ...card.paintedSize(stage))
}

describe('preview card stage aspect', () => {
  it('measures a first painted frame at the default canvas size of 300x150 as 2:1', () => {
    expect(card.stageRatio(null, 'a')).toBe(card.FALLBACK_RATIO)
    const { stage } = stageWithCanvas(300, 150)
    const ratio = card.stageRatio(paint(null, 'a', stage), 'a')
    expect(Math.abs(ratio / 2 - 1)).toBeLessThanOrEqual(0.03)
    expect(ratio).not.toBe(card.FALLBACK_RATIO)
  })

  it('updates the ratio after each paint when the stream size changes mid-stream', () => {
    const { canvas, stage } = stageWithCanvas(1280, 800)
    let size = paint(null, 'a', stage)
    expect(card.stageRatio(size, 'a')).toBeCloseTo(1280 / 800)
    Object.assign(canvas, { width: 420, height: 760 })
    size = paint(size, 'a', stage)
    expect(card.stageRatio(size, 'a')).toBeCloseTo(420 / 760)
    Object.assign(canvas, { width: 300, height: 1400 })
    size = paint(size, 'a', stage)
    expect(card.stageRatio(size, 'a')).toBeCloseTo(300 / 1400)
  })

  it('keeps the same state object when a paint does not change the size', () => {
    const { stage } = stageWithCanvas(420, 760)
    const size = paint(null, 'a', stage)
    expect(paint(size, 'a', stage)).toBe(size)
  })

  it('never lets a card with another frame id inherit the previous ratio', () => {
    const portrait = paint(null, 'a', stageWithCanvas(420, 760).stage)
    expect(card.stageRatio(portrait, 'b')).toBe(card.FALLBACK_RATIO)
    const own = paint(portrait, 'b', stageWithCanvas(1280, 800).stage)
    expect(card.stageRatio(own, 'b')).toBeCloseTo(1280 / 800)
    expect(card.stageRatio(own, 'a')).toBe(card.FALLBACK_RATIO)
  })

  it('ignores missing or invalid dimensions', () => {
    expect(card.recordStageSize(null, 'a', 0, 150)).toBeNull()
    expect(card.recordStageSize(null, 'a', Number.NaN, 150)).toBeNull()
    expect(card.paintedSize(null)).toEqual([0, 0])
  })

  it('follows chat resizes for the height cap and disconnects the observer on unmount', () => {
    const observers: FakeObserver[] = []
    class FakeObserver {
      observed: unknown[] = []
      disconnected = false
      constructor(readonly callback: () => void) { observers.push(this) }
      observe(target: unknown) { this.observed.push(target) }
      disconnect() { this.disconnected = true }
    }
    Object.assign(globalThis, { ResizeObserver: FakeObserver })
    let height = 600
    const chat = { getBoundingClientRect: () => ({ height }) }
    const stage = { closest: (selector: string) => selector.includes('.bots-chat') ? chat : null } as unknown as Element
    const caps: number[] = []
    const stop = card.observeChatCap(stage, cap => caps.push(cap))
    expect(caps).toEqual([300])
    expect(observers[0]?.observed).toEqual([chat])
    height = 400
    observers[0]?.callback()
    observers[0]?.callback()
    expect(caps).toEqual([300, 200])
    height = 0
    observers[0]?.callback()
    expect(caps).toEqual([300, 200])
    stop()
    expect(observers[0]?.disconnected).toBe(true)
  })
})
