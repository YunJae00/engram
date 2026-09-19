import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { Page } from 'playwright-core'
import type { BrowserTabDto } from '../shared/types.js'
import { activeLaneName, addAgentPage, lanePage, lanePages, selectLanePage, watchAgentPages } from './agent-browser.js'
import { lookAtLane } from './agent-view.js'
import { broadcast } from './engine-health.js'
import { refreshNativeLayout } from './native-layout.js'

const ids = new WeakMap<Page, string>()
const titles = new WeakMap<Page, { url: string; title: string }>()
function idOf(page: Page): string {
  let id = ids.get(page)
  if (!id) { id = randomUUID(); ids.set(page, id) }
  return id
}
function snapshot(lane: string): BrowserTabDto[] {
  return lanePages(lane).map(page => ({ id: idOf(page), url: page.url(), title: titles.get(page)?.url === page.url() ? titles.get(page)?.title : undefined, active: page === lanePage(lane) }))
}
function channel(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w:-]{1,160}$/.test(value)) throw new Error('Invalid browser conversation')
  return value
}

export function registerBrowserTabs(busy: (lane: string) => boolean): void {
  const watched = new WeakSet<Page>()
  const changed = (lane: string) => broadcast({ type: 'agent:tabs', lane, tabs: snapshot(lane) })
  watchAgentPages((page, lane) => {
    if (!lane) return
    if (!watched.has(page)) {
      watched.add(page)
      const title = async () => {
        const url = page.url()
        try {
          const value = (await page.title()).trim().slice(0, 160)
          if (page.isClosed() || page.url() !== url) return
          titles.set(page, { url, title: value }); changed(lane)
        } catch { /* Navigation can replace the document before its title arrives. */ }
      }
      page.on('domcontentloaded', () => { void title() })
      void title()
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) changed(lane) })
      page.on('close', () => { changed(lane); void refreshNativeLayout() })
    }
    changed(lane)
    void refreshNativeLayout()
  })
  ipcMain.handle('agent:tabs', (_event, lane: unknown) => snapshot(channel(lane)))
  ipcMain.handle('agent:tab', async (_event, laneValue: unknown, action: unknown, id: unknown) => {
    const lane = channel(laneValue)
    if (busy(lane)) throw new Error('Stop the current task before changing its browser tab')
    if (action === 'add') await addAgentPage(lane)
    else {
      const page = lanePages(lane).find(page => ids.get(page) === id)
      if (!page) throw new Error('That tab is no longer open in this conversation')
      if (action === 'select') selectLanePage(lane, page)
      else if (action === 'close') await page.close()
      else throw new Error('Invalid tab action')
    }
    if (activeLaneName() === lane) await lookAtLane(lane)
    await refreshNativeLayout()
    changed(lane)
    return snapshot(lane)
  })
}
