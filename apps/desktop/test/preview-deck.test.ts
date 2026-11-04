import { expect, it, vi } from 'vitest'
import { previewOrder, previewAppVisible, previewNeighbor } from '../src/renderer/src/components/PreviewDeck.js'
import type { PreviewFrame } from '../src/renderer/src/components/usePreviewFrames.js'
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/webPane.js', () => ({ useWebPane: () => ({}), webPane: {} }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
const frame = (id: string, at: number, source: 'web' | 'app' = 'app'): PreviewFrame => ({ id, at, source, title: id, phase: 'ready' })
it('starts with the newest frame and brings new frames forward', () => {
  expect(previewOrder([], [frame('old', 1), frame('new', 2)])).toEqual(['new', 'old'])
  expect(previewOrder(['old'], [frame('old', 1), frame('new', 2)])).toEqual(['new', 'old'])
})
it('retains the selected front card and inserts new cards immediately behind it', () => {
  expect(previewOrder(['a', 'b'], [frame('a', 1), frame('b', 2), frame('c', 3)], 'b')).toEqual(['b', 'c', 'a'])
  expect(previewOrder(['b', 'c', 'a'], [frame('a', 4), frame('b', 2), frame('c', 3)], 'b')).toEqual(['b', 'c', 'a'])
  expect(previewOrder(['a', 'b'], [frame('a', 1)], 'b')).toEqual(['a'])
})
it('opens the app stream only for an expanded app front card', () => {
  const expanded = { hidden: false, collapsed: false }
  expect(previewAppVisible(frame('app', 1), expanded)).toBe(true)
  expect(previewAppVisible(frame('web', 1, 'web'), expanded)).toBe(false)
  expect(previewAppVisible(frame('app', 1), { ...expanded, collapsed: true })).toBe(false)
  expect(previewAppVisible(frame('app', 1), { ...expanded, hidden: true })).toBe(false)
  expect(previewAppVisible({ ...frame('office', 1), phase: 'activity' }, expanded)).toBe(false)
})

it('cycles all three frames even after each selected card moves to the front', () => {
  const frames = [frame('a', 1), frame('b', 2), frame('c', 3)]
  expect(previewNeighbor(frames, 'a', 1)).toBe('b')
  expect(previewNeighbor(frames, 'b', 1)).toBe('c')
  expect(previewNeighbor(frames, 'c', 1)).toBe('a')
  expect(previewNeighbor(frames, 'a', -1)).toBe('c')
})
