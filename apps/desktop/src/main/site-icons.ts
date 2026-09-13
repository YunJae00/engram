import { nativeImage, net } from 'electron'

const icons = new Map<string, Promise<string | null>>()
const LIMIT = 128 * 1024

// Only visited origins reach here. No page path, cookies, redirects or third-party icon service.
export function siteIcon(origin: string): Promise<string | null> {
  let url: URL
  try { url = new URL(origin) } catch { return Promise.resolve(null) }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.port) return Promise.resolve(null)
  const held = icons.get(origin)
  if (held) return held
  const pending = (async () => {
    try {
      const response = await net.fetch(`${origin}/favicon.ico`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(4000) })
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
      const icon = nativeImage.createFromBuffer(Buffer.concat(chunks))
      if (icon.isEmpty()) return null
      return icon.resize({ width: 32, height: 32 }).toDataURL()
    } catch { return null }
  })()
  if (icons.size >= 128) icons.delete(icons.keys().next().value!)
  icons.set(origin, pending)
  return pending
}
