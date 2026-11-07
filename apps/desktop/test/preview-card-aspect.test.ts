import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/lib/webPane.js', () => ({ useWebPane: () => ({ attention: false }), webPane: {} }))
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
import { FALLBACK_RATIO, PreviewCard, measuredSize, observeChatCap, paintedSize, stageRatio, type StageSize } from '../src/renderer/src/components/PreviewCard.js'

const canvasStage = (canvas: { width: number; height: number }) => ({ querySelector: (selector: string) => selector === 'canvas' ? canvas : null }) as unknown as ParentNode
const paint = (size: StageSize | null, id: string, stage: ParentNode): StageSize | null => {
  const painted = paintedSize(stage)
  return painted ? measuredSize(size, id, painted.width, painted.height) : size
}
const within = (actual: number, expected: number) => expect(Math.abs(actual / expected - 1)).toBeLessThanOrEqual(0.03)

describe('preview card stage aspect', () => {
  it('measures a first painted 300x150 frame as 2:1 although the canvas never changed size', () => {
    const canvas = { width: 300, height: 150 }
    const size = paint(null, 'stream-1', canvasStage(canvas))
    within(stageRatio(size, 'stream-1'), 2)
    expect(stageRatio(size, 'stream-1')).not.toBe(FALLBACK_RATIO)
  })

  it('updates the ratio after each paint when the stream changes size mid-way', () => {
    const canvas = { width: 1280, height: 800 }
    const stage = canvasStage(canvas)
    const ratios: number[] = []
    let size: StageSize | null = null
    for (const [width, height] of [[1280, 800], [420, 760], [300, 1400]] as const) {
      canvas.width = width
      canvas.height = height
      size = paint(size, 'stream-1', stage)
      ratios.push(stageRatio(size, 'stream-1'))
    }
    within(ratios[0]!, 1280 / 800)
    within(ratios[1]!, 420 / 760)
    within(ratios[2]!, 300 / 1400)
  })

  it('keeps the same state object for an unchanged or invalid size', () => {
    const size = measuredSize(null, 'a', 420, 760)
    expect(measuredSize(size, 'a', 420, 760)).toBe(size)
    expect(measuredSize(size, 'a', 0, 760)).toBe(size)
    expect(measuredSize(size, 'a', Number.NaN, 760)).toBe(size)
  })

  it('never lets a card with another frame id inherit the previous ratio', () => {
    const size = measuredSize(null, 'portrait', 420, 760)
    expect(stageRatio(size, 'landscape')).toBe(FALLBACK_RATIO)
    within(stageRatio(measuredSize(size, 'landscape', 1280, 800), 'landscape'), 1280 / 800)
  })

  it('renders the fallback ratio before the first paint', () => {
    const html = renderToStaticMarkup(createElement(PreviewCard, {
      frame: { id: 'fresh', source: 'app', title: 'Window', at: 1, phase: 'ready', stream: () => () => {} },
      busy: true, state: 'recorded', lang: 'en', lane: 'unit-aspect', compact: false, onCollapse() {}, onHide() {},
    }))
    expect(html).toContain(`aspect-ratio:${FALLBACK_RATIO}`)
  })

  it('follows chat resizes with the height cap and disconnects on unmount', () => {
    let height = 600
    const chat = { getBoundingClientRect: () => ({ height }) }
    const stage = { closest: (selector: string) => selector.includes('.bots-chat') ? chat : null } as unknown as Element
    const observers: { callback: () => void; observed: unknown[]; disconnected: boolean }[] = []
    class FakeObserver {
      record: { callback: () => void; observed: unknown[]; disconnected: boolean }
      constructor(callback: () => void) { this.record = { callback, observed: [], disconnected: false }; observers.push(this.record) }
      observe(target: unknown) { this.record.observed.push(target) }
      disconnect() { this.record.disconnected = true }
    }
    const caps: number[] = []
    const stop = observeChatCap(stage, pixels => caps.push(pixels), FakeObserver as unknown as new (callback: () => void) => ResizeObserver)
    expect(caps).toEqual([300])
    expect(observers[0]!.observed).toEqual([chat])
    height = 420
    observers[0]!.callback()
    expect(caps).toEqual([300, 210])
    stop()
    expect(observers[0]!.disconnected).toBe(true)
  })
})
