import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkPreviewDto } from '../src/shared/desktop.js'
const pane = vi.hoisted(() => ({ attention: false }))
vi.mock('../src/renderer/src/lib/webPane.js', () => ({ useWebPane: () => pane, webPane: {} }))
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
import { appPreviewFrame } from '../src/renderer/src/components/usePreviewFrames.js'
import { PreviewCard } from '../src/renderer/src/components/PreviewCard.js'
import { threadWords } from '../src/renderer/src/lib/threadLang.js'

const frame: WorkPreviewDto = { id: 'window-1', lane: 'bot-one', title: 'Document', at: 123, data: 'data:image/png;base64,safe', current: false }
describe('unified preview adapter', () => {
  it('preserves image, identity, time and current marker', () => {
    expect(appPreviewFrame(frame)).toEqual({ id: frame.id, source: 'app', title: frame.title, at: 123, image: frame.data, phase: 'ready', reason: undefined, current: false })
  })
  it.each(['waiting', 'delayed', 'no-snapshot', 'unavailable', 'ready'] as const)('preserves the %s capture state', captureState => {
    expect(appPreviewFrame({ ...frame, captureState }).phase).toBe(captureState)
  })
  it('gives unavailable precedence over a stale ready state', () => {
    expect(appPreviewFrame({ ...frame, captureState: 'ready', unavailable: true }).phase).toBe('unavailable')
  })
  it.each(['capture_unsafe', 'screen_recording_denied'] as const)('preserves the %s explanation', captureReason => {
    expect(appPreviewFrame({ ...frame, captureReason }).reason).toBe(captureReason)
  })
  it('uses generic unavailable copy for an unspecified capture failure', () => {
    expect(appPreviewFrame({ ...frame, captureReason: 'capture_unavailable', captureState: 'unavailable' })).toMatchObject({ phase: 'unavailable', reason: undefined })
  })
})
it('formats snapshot age with localized seconds and whole minutes', () => {
  expect([0, 59, 60, 125].map(threadWords('en').workPreview.snapshotAge)).toEqual(['0s', '59s', '1m', '2m'])
  expect([0, 59, 60, 125].map(threadWords('ko').workPreview.snapshotAge)).toEqual(['0초 전', '59초 전', '1분 전', '2분 전'])
})

it.each([true, false])('starts expanded regardless of whether the turn is busy (%s)', busy => {
  const html = renderToStaticMarkup(createElement(PreviewCard, { frames: [appPreviewFrame(frame)], busy, state: 'recorded', lang: 'en', lane: `unit-${busy}`, compact: false }))
  expect(html).toContain('data-testid="preview-card"')
  expect(html).toContain('Last snapshot')
  expect(html).not.toContain('data-testid="preview-card-collapsed"')
})
it('stays expanded with a waiting label during approval waits and attention', () => {
  const render = (state: 'recorded' | 'waiting') => renderToStaticMarkup(createElement(PreviewCard, { frames: [appPreviewFrame(frame)], busy: false, state, lang: 'en', lane: 'unit-wait', compact: false }))
  expect(render('waiting')).toContain('Document · Needs you')
  pane.attention = true
  try { expect(render('recorded')).toContain('Document · Needs you') }
  finally { pane.attention = false }
})
