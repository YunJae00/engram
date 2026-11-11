import { describe, expect, it } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { botMenuItems, groupSidebarBots, matchesSidebarSearch, sidebarSearchEmpty } from '../src/renderer/src/lib/sidebarBots.js'

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

  it('primary bot match is not an empty search', () => {
    const hero = bot('main', { primary: true, name: 'Research Buddy' })
    const listed = [bot('a')], hidden = [bot('h', { hidden: true })]
    const none = new Set<string>()
    expect(sidebarSearchEmpty(hero, listed, hidden, 'printing', new Set(['main']))).toBe(false)
    expect(sidebarSearchEmpty(hero, listed, hidden, 'research', none)).toBe(false)
    expect(sidebarSearchEmpty(hero, listed, hidden, 'printing', none)).toBe(true)
    expect(sidebarSearchEmpty(null, listed, hidden, 'printing', new Set(['main']))).toBe(true)
    expect(sidebarSearchEmpty(hero, listed, hidden, 'printing', new Set(['a']))).toBe(false)
    expect(sidebarSearchEmpty(hero, listed, hidden, 'printing', new Set(['h']))).toBe(false)
    expect(sidebarSearchEmpty(hero, listed, hidden, '', none)).toBe(false)
    expect(sidebarSearchEmpty(null, [], [], '', none)).toBe(false)
  })

  it('menu actions map to bots:update/sidebar:change', () => {
    const folders = [{ id: 'fa', name: 'Section A' }, { id: 'fb', name: 'Section B' }]
    const listed = botMenuItems(bot('b'), { folder: 'fb', pinned: false }, folders)
    expect(listed.map(item => item.label)).toEqual(['Rename', 'Pin', 'Move to Section A', 'Move to new section', 'Hide from sidebar', 'Make primary', 'Delete'])
    expect(listed.map(item => item.run)).toEqual([
      { kind: 'rename' },
      { kind: 'layout', change: { action: 'pin-item', id: 'b', pinned: true } },
      { kind: 'layout', change: { action: 'move-item', id: 'b', folder: 'fa' } },
      { kind: 'new-section' },
      { kind: 'update', patch: { hidden: true } },
      { kind: 'update', patch: { primary: true } },
      { kind: 'delete' },
    ])
    const loose = botMenuItems(bot('p'), { folder: null, pinned: true }, folders)
    expect(loose.map(item => item.label)).toEqual(['Rename', 'Unpin', 'Move to Section A', 'Move to Section B', 'Move to new section', 'Hide from sidebar', 'Make primary', 'Delete'])
    expect(loose[1].run).toEqual({ kind: 'layout', change: { action: 'pin-item', id: 'p', pinned: false } })
    const hidden = botMenuItems(bot('h', { hidden: true }), { folder: null, pinned: false }, folders)
    expect(hidden.map(item => item.label)).toEqual(['Rename', 'Show', 'Make primary', 'Delete'])
    const show = hidden[1].run
    if (show.kind !== 'update') throw new Error('Show is not an update')
    expect(Object.keys(show.patch)).toEqual(['hidden'])
    expect(Object.hasOwn(show.patch, 'hidden') && show.patch.hidden === undefined).toBe(true)
    expect(botMenuItems(bot('m', { primary: true }), { folder: null, pinned: false }, folders)).toEqual([])
    expect(botMenuItems(bot('mh', { primary: true, hidden: true }), { folder: null, pinned: false }, folders)).toEqual([])
    for (const item of [...listed, ...loose, ...hidden]) if (item.run.kind === 'update') expect(Object.keys(item.run.patch)).toHaveLength(1)
  })
})
