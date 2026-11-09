import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppWindow, Calendar, FileSpreadsheet, FileText, Globe, Mail, Presentation } from 'lucide-react'
import type { WorkPreviewDto } from '../src/shared/desktop.js'
const pane = vi.hoisted(() => ({ attention: false }))
vi.mock('../src/renderer/src/lib/webPane.js', () => ({ useWebPane: () => pane, webPane: {} }))
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
import { appPreviewFrame } from '../src/renderer/src/components/usePreviewFrames.js'
import { PreviewCard, previewIcon } from '../src/renderer/src/components/PreviewCard.js'
import { PreviewDeck } from '../src/renderer/src/components/PreviewDeck.js'
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
  const html = renderToStaticMarkup(createElement(PreviewDeck, { frames: [appPreviewFrame(frame)], busy, state: 'recorded', lang: 'en', lane: `unit-${busy}`, compact: false }))
  expect(html).toContain('data-testid="preview-card"')
  expect(html).toContain('Last snapshot')
  expect(html).not.toContain('data-testid="preview-card-collapsed"')
})
it('stays expanded with a waiting label during approval waits and attention', () => {
  const render = (state: 'recorded' | 'waiting') => renderToStaticMarkup(createElement(PreviewDeck, { frames: [appPreviewFrame(frame)], busy: false, state, lang: 'en', lane: 'unit-wait', compact: false }))
  expect(render('waiting')).toContain('Document · Needs you')
  pane.attention = true
  try { expect(render('recorded')).toContain('Document · Needs you') }
  finally { pane.attention = false }
})


it.each(['en', 'ko'] as const)('labels stopped streams and reconnection in %s without changing completed snapshots', lang => {
  const words = threadWords(lang).workPreview
  const render = (busy: boolean, reconnecting = false, live = false) => renderToStaticMarkup(createElement(PreviewCard, {
    frame: { ...appPreviewFrame(frame), stream: () => () => {}, live, reconnecting },
    busy, state: 'recorded', lang, lane: 'unit-stream', compact: false, onCollapse() {}, onHide() {},
  }))
  expect(render(true)).toContain(words.stoppedFrame)
  expect(render(true)).toContain(new Date(frame.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false }))
  expect(render(true, true)).toContain(words.reconnecting)
  expect(render(true, false, true)).toContain(words.live)
  expect(render(false)).toContain(words.lastSnapshot)
  expect(render(false)).not.toContain(words.stoppedFrame)
})

it.each(['en', 'ko'] as const)('shows connecting instead of stale capture-unsafe while a stream starts in %s', lang => {
  const render = (connecting: boolean) => renderToStaticMarkup(createElement(PreviewCard, {
    frame: { ...appPreviewFrame({ ...frame, data: undefined, captureState: 'unavailable', captureReason: 'capture_unsafe' }), stream: () => () => {}, live: false, connecting },
    busy: true, state: 'recorded', lang, lane: 'unit-connecting', compact: false, onCollapse() {}, onHide() {},
  }))
  expect(render(true)).toContain(threadWords(lang).workPreview.firstFrame)
  expect(render(true)).not.toContain(threadWords(lang).workPreview.captureUnsafe)
  expect(render(false)).toContain(threadWords(lang).workPreview.captureUnsafe)
})

it('derives each card icon from its own app, never from another card', () => {
  const office = (title: string, activity = 'Working with documents') => previewIcon({ phase: 'activity', title, activity, source: 'app' })
  expect(office('Outlook', 'Checking your mail')).toBe(Mail)
  expect(office('Outlook', 'Checking your calendar')).toBe(Calendar)
  expect(office('Excel')).toBe(FileSpreadsheet)
  expect(office('PowerPoint')).toBe(Presentation)
  expect(office('Word')).toBe(FileText)
  expect(previewIcon({ phase: 'ready', title: 'example.test', source: 'web' })).toBe(Globe)
  expect(previewIcon({ phase: 'ready', title: 'Finder', source: 'app' })).toBe(AppWindow)
})

it('renders Outlook and Excel activity cards with their own chrome whichever is current', () => {
  const card = (id: string, title: string, activity: string, current: boolean) => renderToStaticMarkup(createElement(PreviewCard, {
    frame: appPreviewFrame({ id, lane: 'bot-mix', title, activity, captureState: 'activity', current, at: 1 }),
    busy: true, state: 'recorded', lang: 'en', lane: 'bot-mix', compact: false, onCollapse() {}, onHide() {},
  }))
  const excel = card('office:bot-mix:Excel', 'Excel', 'Working with documents', true)
  const outlook = card('office:bot-mix:Outlook', 'Outlook', 'Checking your mail', false)
  expect(excel).toContain('lucide-file-spreadsheet')
  expect(excel).toContain('Excel · Working with documents')
  expect(excel).not.toContain('lucide-mail')
  expect(outlook).toContain('lucide-mail')
  expect(outlook).toContain('Outlook · Working')
  expect(outlook).not.toContain('Excel')
})
