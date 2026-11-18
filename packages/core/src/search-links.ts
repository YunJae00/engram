const TARGET_PARAMS = ['url', 'q', 'u', 'uddg', 'target', 'dest', 'link', 'to']
const RESOLVE_AT_MOST = 12
const RESOLVE_MS = 10_000

type Link = { text: string; url: string }
type FollowRedirect = (url: string, signal?: AbortSignal) => Promise<string | null>

const webAddress = (value: string | null | undefined): string | null => {
  if (!value) return null
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : null } catch { return null }
}

export function namedTarget(link: string): string | null {
  try {
    const url = new URL(link)
    for (const key of TARGET_PARAMS) {
      const target = webAddress(url.searchParams.get(key))
      if (target && siteOf(new URL(target).host) !== siteOf(url.host)) return target
    }
  } catch { return null }
  return null
}

const SECOND_LEVEL = new Set(['co', 'or', 'ac', 'go', 'ne', 'com', 'net', 'org', 'gov', 'edu'])
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.')
  const keep = labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2
  return labels.slice(-keep).join('.')
}

function sameHost(link: string, page: string): boolean {
  try { return siteOf(new URL(link).host) === siteOf(new URL(page).host) } catch { return false }
}

async function followWithin(follow: FollowRedirect, url: string, signal?: AbortSignal): Promise<string | null> {
  const timer = new AbortController()
  const stop = setTimeout(() => timer.abort(), RESOLVE_MS)
  const both = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  try { return webAddress(await follow(url, both)) } catch { return null } finally { clearTimeout(stop) }
}

export async function resolveResultLinks(links: Link[], resultsPage: string, follow?: FollowRedirect, signal?: AbortSignal): Promise<Link[]> {
  let asked = 0
  const resolved = await Promise.all(links.map(async (link) => {
    if (!sameHost(link.url, resultsPage)) return link
    const named = namedTarget(link.url)
    if (named) return { ...link, url: named }
    if (!follow || asked >= RESOLVE_AT_MOST) return link
    asked++
    const target = await followWithin(follow, link.url, signal)
    return target && !sameHost(target, resultsPage) ? { ...link, url: target } : link
  }))
  signal?.throwIfAborted()
  return resolved
}
