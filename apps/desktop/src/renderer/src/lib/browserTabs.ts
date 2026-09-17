import { useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { webPane } from './webPane.js'

// Browser tabs are just lanes: each tab owns one lane, and the main process
// already keeps one real page per lane. The first tab keeps the legacy
// "browser" lane name so nothing else has to change. Not persisted across
// launches — a browser session is ephemeral, and stale lanes would show empty.
// ponytail: add localStorage persistence only if users ask to reopen tabs.

export interface BrowserTab { id: number; lane: string; title: string }

const MAX_TABS = 8
let seq = 1
let tabs: BrowserTab[] = [{ id: 0, lane: 'browser', title: '' }]
let activeId = 0
let snapshot = { tabs, activeId }
const listeners = new Set<() => void>()

function changed(): void {
  snapshot = { tabs, activeId }
  for (const l of listeners) l()
}

export const browserTabs = {
  subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l) },
  read: () => snapshot,
  activeLane: () => tabs.find((t) => t.id === activeId)?.lane ?? 'browser',
  select(id: number): void {
    if (id === activeId || !tabs.some((t) => t.id === id)) return
    activeId = id
    webPane.open(browserTabs.activeLane())
    changed()
  },
  add(): void {
    if (tabs.length >= MAX_TABS) return
    const id = seq++
    tabs = [...tabs, { id, lane: `browser:${id}`, title: '' }]
    activeId = id
    webPane.open(`browser:${id}`)
    changed()
  },
  close(id: number): void {
    if (tabs.length <= 1) return // never leave the browser with no tab
    const index = tabs.findIndex((t) => t.id === id)
    if (index < 0) return
    const gone = tabs[index]!
    tabs = tabs.filter((t) => t.id !== id)
    void api.agentReset(gone.lane).catch(() => {})
    if (activeId === id) activeId = (tabs[index] ?? tabs[tabs.length - 1]!).id
    changed()
  },
  // The active tab's title follows its page; a blank one reads as "New tab".
  setTitle(lane: string, title: string): void {
    const tab = tabs.find((t) => t.lane === lane)
    if (!tab || tab.title === title) return
    tabs = tabs.map((t) => (t.lane === lane ? { ...t, title } : t))
    changed()
  },
}

export function useBrowserTabs(): { tabs: BrowserTab[]; activeId: number } {
  return useSyncExternalStore(browserTabs.subscribe, browserTabs.read)
}
