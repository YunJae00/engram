import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { PreviewDeck } from '../src/renderer/src/components/PreviewDeck.js'
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

it('keeps every deck position on its own app chrome after the current card changes', () => {
  const office = (title: string, activity: string, at: number, current: boolean): PreviewFrame => ({ id: `office:bot-x:${title}`, source: 'app', title, activity, at, current, phase: 'activity' })
  const web: PreviewFrame = { id: 'bot-x:web:https://example.test/', source: 'web', title: 'example.test', at: 3, phase: 'ready' }
  const positions = (frames: PreviewFrame[]) => {
    const html = renderToStaticMarkup(createElement(PreviewDeck, { frames, busy: true, state: 'recorded', lang: 'en', lane: 'unit-deck-chrome', compact: false }))
    return html.split('data-position=').slice(1)
  }
  const before = [office('Outlook', 'Checking your mail', 1, false), office('Excel', 'Working with documents', 2, true), web]
  const [front, second, third] = positions(before)
  expect(front).toContain(`data-frame="${web.id}"`)
  expect(front).toContain('data-source="web"')
  expect(front).toContain('lucide-globe')
  expect(second).toContain('aria-label="Excel"')
  expect(third).toContain('aria-label="Outlook"')
  const after = [office('Outlook', 'Checking your calendar', 4, true), office('Excel', 'Working with documents', 2, false), web]
  const kept = previewOrder(previewOrder([], before), after)
  expect(kept).toEqual([web.id, 'office:bot-x:Excel', 'office:bot-x:Outlook'])
  for (const block of positions(after)) {
    const id = /data-frame="([^"]+)"/.exec(block)![1]!
    const own = after.find(frame => frame.id === id)!
    if (block.startsWith('"0"')) expect(block).toContain(own.title === 'Outlook' ? 'Outlook · Checking your calendar' : own.title)
    else expect(block).toContain(`aria-label="${own.title}"`)
    for (const other of after) if (other.id !== id) expect(block).not.toContain(`aria-label="${other.title}"`)
  }
})
