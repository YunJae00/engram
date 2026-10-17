// A results page links to its own redirector, not to the result: the address
// says nothing about where it leads, and opening it costs a page load on the
// search engine before the real one begins. The target is read from the link
// itself when it carries one, or from the redirect the engine answers with.
const TARGET_PARAMS = ['url', 'q', 'u', 'uddg', 'target', 'dest']
const RESOLVE_AT_MOST = 12
const RESOLVE_MS = 4_000

type Link = { text: string; url: string }
export type FollowRedirect = (url: string, signal?: AbortSignal) => Promise<string | null>

const webAddress = (value: string | null | undefined): string | null => {
  if (!value) return null
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : null } catch { return null }
}

// The target a wrapper link names in its own query, when it names one in the clear.
export function namedTarget(link: string): string | null {
  try {
    const url = new URL(link)
    for (const key of TARGET_PARAMS) {
      const target = webAddress(url.searchParams.get(key))
      if (target && new URL(target).host !== url.host) return target
    }
  } catch { return null }
  return null
}

function sameHost(link: string, page: string): boolean {
  try { return new URL(link).host === new URL(page).host } catch { return false }
}

async function followWithin(follow: FollowRedirect, url: string, signal?: AbortSignal): Promise<string | null> {
  const timer = new AbortController()
  const stop = setTimeout(() => timer.abort(), RESOLVE_MS)
  const both = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  try { return webAddress(await follow(url, both)) } catch { return null } finally { clearTimeout(stop) }
}

// Links on the results page that lead back through the engine are replaced by
// where they go; the rest are left as they are.
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
