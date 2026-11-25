import { existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import type { Download, Page } from 'playwright-core'
import { flog } from './flog.js'

const saved = new Map<string, string[]>()
const watched = new WeakSet<Page>()

export function watchDownloads(laneOf: (page: Page) => string | null, folder: () => string): (page: Page) => void {
  return (page) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('download', (download) => void keep(download, laneOf(page), folder))
  }
}

export function takeDownloads(lane: string): string[] {
  const files = saved.get(lane) ?? []
  saved.delete(lane)
  return files
}

async function keep(download: Download, lane: string | null, folder: () => string): Promise<void> {
  try {
    const target = freeName(folder(), download.suggestedFilename() || 'download')
    await download.saveAs(target)
    flog('page-download', target)
    if (lane) saved.set(lane, [...(saved.get(lane) ?? []), target])
  } catch (error) {
    flog('page-download', `failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function freeName(folder: string, name: string): string {
  const safe = basename(name).replace(/[<>:"/\\|?*]/g, '_')
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let path = join(folder, safe)
  for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}
