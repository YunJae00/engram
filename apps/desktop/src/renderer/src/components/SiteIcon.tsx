import { Globe } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { api } from '../api.js'

export const SiteIcon = memo(function SiteIcon({ origin, shortcut = false }: { origin: string; shortcut?: boolean }) {
  const [image, setImage] = useState<{ origin: string; url: string } | null>(null)
  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const read = (retryOnce = true) => {
      clearTimeout(retry)
      void api.siteIcon(origin, shortcut).catch(() => null).then(value => {
        if (!alive) return
        setImage(value ? { origin, url: value } : null)
        if (!value && retryOnce) retry = setTimeout(() => read(false), 2000)
      })
    }
    read()
    const off = api.onEvent(event => { if (event.type === 'bots:changed') read() })
    return () => { alive = false; clearTimeout(retry); off() }
  }, [origin, shortcut])
  return image?.origin === origin ? <img className="site-icon" src={image.url} width={16} height={16} alt="" onError={() => setImage(null)} /> : <Globe className="site-icon" size={16} aria-hidden />
})

export function answerSites(text: string): { origin: string; url: string; label: string }[] {
  const seen = new Set<string>()
  const sites: { origin: string; url: string; label: string }[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`\])]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ''))
      if (url.username || url.password || seen.has(url.origin)) continue
      seen.add(url.origin)
      sites.push({ origin: url.origin, url: url.href, label: url.hostname.replace(/^www\./, '') })
      if (sites.length === 5) break
    } catch { /* Incomplete streaming links wait for more text. */ }
  }
  return sites
}
