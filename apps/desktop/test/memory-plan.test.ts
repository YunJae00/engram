import { describe, expect, it } from 'vitest'
import { reserveRoom, ROOM_FOR_EMBEDDER, roomNow } from '../src/main/memory-plan.js'

// A heavyweight is admitted against the memory it is about to spend, not the
// memory it has spent; until it is handed back, that room is not there for
// anything else to be planned into.
describe('reserveRoom', () => {
  it('takes spoken-for room out of the plan until it is released', () => {
    const release = reserveRoom(1e15)
    expect(roomNow()).toBe(0)
    release()
    release()
    expect(roomNow()).toBeGreaterThan(0)
  })

  it('never reads as less than nothing, however much is spoken for', () => {
    const release = reserveRoom(Number.MAX_SAFE_INTEGER)
    expect(roomNow()).toBe(0)
    release()
  })

  it('the embedder is judged by its own small weight', () => {
    expect(ROOM_FOR_EMBEDDER).toBeLessThan(8e9)
  })
})
