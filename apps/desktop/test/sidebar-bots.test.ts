import { describe, expect, it } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { groupSidebarBots, matchesSidebarSearch } from '../src/renderer/src/lib/sidebarBots.js'

const bot = (id: string, extra: Partial<BotDto> = {}): BotDto => ({ id, name: `Bot ${id}`, purpose: `purpose ${id}`, createdAt: '2026-01-01T00:00:00.000Z', ...extra })

describe('sidebar bots', () => {
  it('no 24h filter, primary in hero not list, hidden grouped last', () => {
    const old = bot('old', { lastMessage: { role: 'user', text: 'hi', at: new Date(Date.now() - 3 * 86_400_000).toISOString() } })
    const primary = bot('main', { primary: true }), second = bot('second', { primary: true })
    const h1 = bot('h1', { hidden: true }), h2 = bot('h2', { hidden: true })
    const input = [h2, old, primary, h1, second]
    const copy = [...input]
    const grouped = groupSidebarBots(input)
    expect(grouped.hero).toBe(primary)
    expect(grouped.listed).toEqual([old, second])
    expect(grouped.hidden).toEqual([h2, h1])
    expect(input).toEqual(copy)
    const hiddenPrimary = bot('hp', { primary: true, hidden: true })
    const again = groupSidebarBots([h1, hiddenPrimary, old])
    expect(again.hero).toBe(hiddenPrimary)
    expect(again.listed).toEqual([old])
    expect(again.hidden).toEqual([h1])
    expect(groupSidebarBots([old])).toEqual({ hero: null, listed: [old], hidden: [] })
  })

  it('search matches name, label, purpose, last message and body hits', () => {
    const one = bot('x', { name: 'Garden Planner', label: 'Seasonal', purpose: 'Grow Tomatoes', lastMessage: { role: 'assistant', text: 'Water at Dawn', at: '2026-01-02T00:00:00.000Z' } })
    const none = new Set<string>()
    expect(matchesSidebarSearch(one, '', none)).toBe(true)
    for (const query of ['garden', 'seasonal', 'tomatoes', 'dawn']) expect(matchesSidebarSearch(one, query, none)).toBe(true)
    expect(matchesSidebarSearch(one, 'zebra', none)).toBe(false)
    expect(matchesSidebarSearch(one, 'zebra', new Set(['x']))).toBe(true)
    expect(matchesSidebarSearch(one, 'zebra', new Set(['y']))).toBe(false)
    expect(matchesSidebarSearch(bot('plain'), 'seasonal', none)).toBe(false)
  })
})
