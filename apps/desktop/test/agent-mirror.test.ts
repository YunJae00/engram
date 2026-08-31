import { describe, expect, it } from 'vitest'
import { createAgentMirror } from '../src/renderer/src/lib/agentMirror.js'

const FRAME = { type: 'agent:frame' as const, data: 'aGk=', width: 1280, height: 800, url: 'https://x.example/one' }

describe('the browser picture outlives the view that showed it', () => {
  it('asks for the stream once however many views look, and lets it go when the last leaves', () => {
    const asked: boolean[] = []
    const mirror = createAgentMirror((on) => asked.push(on))
    const first = mirror.subscribe(() => {})
    const second = mirror.subscribe(() => {})
    expect(asked).toEqual([true])
    first()
    expect(asked).toEqual([true])
    second()
    expect(asked).toEqual([true, false])
  })

  it('keeps the last frame when the window goes, and through a view coming and going', () => {
    const mirror = createAgentMirror(() => {})
    const off = mirror.subscribe(() => {})
    mirror.handleEvent(FRAME)
    expect(mirror.getSnapshot()).toMatchObject({ on: true, frame: 'data:image/jpeg;base64,aGk=', url: 'https://x.example/one' })
    // The browser closes: the picture stays, so the person can still read the
    // answer against what was on screen.
    mirror.handleEvent({ type: 'agent:live', on: false })
    expect(mirror.getSnapshot()).toMatchObject({ on: false, frame: 'data:image/jpeg;base64,aGk=' })
    // Leaving the thread and coming back does not wipe it.
    off()
    mirror.subscribe(() => {})
    expect(mirror.getSnapshot().frame).toBe('data:image/jpeg;base64,aGk=')
    // A new window starts blank rather than showing the page before it.
    mirror.handleEvent({ type: 'agent:live', on: true, url: 'https://x.example/two' })
    expect(mirror.getSnapshot()).toMatchObject({ on: true, frame: null, url: 'https://x.example/two' })
  })
})
