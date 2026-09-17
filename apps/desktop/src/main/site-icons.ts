import { app, net } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const icons = new Map<string, Promise<string | null>>()
const LIMIT = 128 * 1024
const DISK_CAP = 256

// Successful icons persist to one small JSON file so a returning user sees the
// sidebar shortcuts painted from the first frame instead of re-fetching every
// origin on each launch. Only data-URL hits are stored; a miss stays uncached
// and retries next time.
let diskLoad: Promise<Map<string, string>> | null = null
// null when there is no app to give a userData path (unit tests): the cache
// then lives only in memory for the process, which is the old behaviour.
function cacheFile(): string | null {
  try { return join(app.getPath('userData'), 'site-icons.json') } catch { return null }
}
function loadDisk(): Promise<Map<string, string>> {
  return (diskLoad ??= (async () => {
    const file = cacheFile()
    if (!file) return new Map<string, string>()
    try { return new Map(Object.entries(JSON.parse(await readFile(file, 'utf8')) as Record<string, string>)) }
    catch { return new Map<string, string>() }
  })())
}
async function persist(disk: Map<string, string>): Promise<void> {
  const file = cacheFile()
  if (!file) return
  // Newest-last insertion order; trim the oldest when over the cap.
  while (disk.size > DISK_CAP) disk.delete(disk.keys().next().value!)
  await writeFile(file, JSON.stringify(Object.fromEntries(disk))).catch(() => undefined)
}

// Visited or user-selected shortcut origins only. No paths, cookies, redirects or third-party service.
export async function siteIcon(origin: string): Promise<string | null> {
  let url: URL
  try { url = new URL(origin) } catch { return null }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const held = icons.get(origin)
  if (held) return held
  const disk = await loadDisk()
  const saved = disk.get(origin)
  if (saved) return saved
  const pending = (async () => {
    try {
      const response = await net.fetch(`${origin}/favicon.ico`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (!response.ok || !response.body || !/^image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); return null }
      const chunks: Uint8Array[] = []
      const reader = response.body.getReader()
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > LIMIT) return null
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const mime = response.headers.get('content-type')!.split(';', 1)[0]!.toLowerCase()
      return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
    } catch { return null }
  })()
  if (icons.size >= 128) icons.delete(icons.keys().next().value!)
  icons.set(origin, pending)
  void pending.then(value => {
    if (!value) { if (icons.get(origin) === pending) icons.delete(origin); return }
    disk.set(origin, value)
    void persist(disk)
  })
  return pending
}
