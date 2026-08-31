import { describe, expect, it } from 'vitest'
import { createAgentMirror } from '../src/renderer/src/lib/agentMirror.js'

const FRAME = { type: 'agent:frame' as const, data: 'aGk=', width: 1280, height: 800, url: 'https://x.example/one' }

describe('the browser picture outlives the view that showed it', () => {
  it('asks for frames only while a view is showing them, once for however many', () => {
    const asked: boolean[] = []
    const mirror = createAgentMirror({ watch: (on) => asked.push(on), ask: async () => ({ on: false }) })
    // Watching the store costs nothing: a view that shows the address alone
    // asks for no frames at all.
    const off = mirror.subscribe(() => {})
    expect(asked).toEqual([])
    mirror.showPixels(true)
    mirror.showPixels(true)
    expect(asked).toEqual([true])
    mirror.showPixels(false)
    expect(asked).toEqual([true])
    mirror.showPixels(false)
    expect(asked).toEqual([true, false])
    off()
  })

  it('keeps the last frame when the window goes, and through a view coming and going', () => {
    const mirror = createAgentMirror({ watch: () => {}, ask: async () => ({ on: false }) })
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
