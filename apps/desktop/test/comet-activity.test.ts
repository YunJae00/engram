import { describe, expect, it } from 'vitest'
import { activitySnapshot, cometActivity } from '../src/renderer/src/lib/cometActivity.js'
import { cometChannel, createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

describe('comet activity', () => {
  it('keeps independent running, waiting, failed and ready states', () => {
    const store = createCometThreads(null)
    for (const id of ['a', 'b', 'c']) store.begin(id, 'Work')
    store.fail('c', 'Connection failed')
    expect(cometActivity(store.thread('a'))).toBe('running')
    expect(cometActivity(store.thread('b'), false, true)).toBe('waiting')
    expect(cometActivity(store.thread('c'))).toBe('error')
    expect(cometActivity(undefined)).toBe('ready')
  })

  it('clears attention on retry and restores neutral state on completion or stop', () => {
    const store = createCometThreads(null)
    store.begin('a', 'Work')
    store.fail('a', 'Offline')
    store.begin('a', 'Retry')
    expect(cometActivity(store.thread('a'))).toBe('running')
    store.handleEvent({ type: 'chat:done', channel: cometChannel('a'), text: 'Done' })
    expect(cometActivity(store.thread('a'), false, true)).toBe('ready')
    store.begin('a', 'Again')
    store.stop('a', 'Stopped')
    expect(cometActivity(store.thread('a'), true, true)).toBe('ready')
  })

  it('recognizes a running channel before its transcript loads', () => {
    expect(cometActivity(undefined, true)).toBe('running')
    expect(cometActivity(undefined, true, true)).toBe('waiting')
    expect(cometActivity(undefined, false, true)).toBe('ready')
  })

  it('does not publish a different activity snapshot for tokens, drafts or work lines', () => {
    const store = createCometThreads(null)
    store.begin('a', 'Work')
    const initial = activitySnapshot(store.getSnapshot().threads)
    store.handleEvent({ type: 'chat:token', channel: cometChannel('a'), text: 'Hello' })
    store.handleEvent({ type: 'comet:step', channel: cometChannel('a'), line: 'Reading' })
    store.setDraft('a', 'Next question')
    expect(activitySnapshot(store.getSnapshot().threads)).toBe(initial)
    store.handleEvent({ type: 'chat:done', channel: cometChannel('a'), text: 'Done' })
    expect(activitySnapshot(store.getSnapshot().threads)).not.toBe(initial)
  })
})
