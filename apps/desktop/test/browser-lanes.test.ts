import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { BrowserLanes } from '../src/main/browser-lanes.js'

function page() {
  let closed = false
  const events = new EventEmitter()
  return Object.assign(events, { isClosed: () => closed, close: () => { closed = true; events.emit('close') } }) as unknown as Page
}

describe('browser lane ownership', () => {
  it('returns to the opener when a popup closes without switching another lane', async () => {
    const restored = vi.fn(), lanes = new BrowserLanes(restored)
    const first = page(), second = page(), popup = page(), nested = page()
    lanes.set('one', first)
    lanes.set('two', second)
    lanes.set('one', popup)
    lanes.set('one', nested)
    expect(lanes.owner(first)).toBe('one')
    expect(lanes.pages('one')).toEqual([first, popup, nested])
    await nested.close()
    expect(lanes.get('one')).toBe(popup)
    await popup.close()
    expect(lanes.get('one')).toBe(first)
    expect(lanes.get('two')).toBe(second)
    expect(restored).toHaveBeenLastCalledWith(first, 'one')
    await first.close()
    expect(lanes.get('one')).toBeUndefined()
    expect(lanes.size).toBe(1)
  })

  it('never resurrects a reset lane when its remaining pages close', async () => {
    const restored = vi.fn(), lanes = new BrowserLanes(restored)
    const first = page(), popup = page()
    lanes.set('one', first)
    lanes.set('one', popup)
    lanes.delete('one')
    await popup.close()
    await first.close()
    expect(restored).not.toHaveBeenCalled()
    expect(lanes.size).toBe(0)
    expect(lanes.owner(first)).toBeNull()
  })
})
