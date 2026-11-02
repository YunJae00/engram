import { describe, expect, it, vi } from 'vitest'
import type { WorkPreviewDto } from '../src/shared/desktop.js'
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
import { appPreviewFrame } from '../src/renderer/src/components/usePreviewFrames.js'
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
  expect([0, 59, 60, 125].map(threadWords('ko').workPreview.snapshotAge)).toEqual(['0초', '59초', '1분', '2분'])
})
