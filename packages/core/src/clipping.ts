// URL clipping: fetch → title + readable text as markdown.
// Extraction is deliberately naive — the librarian summarizes downstream.

export interface Clip {
  url: string
  title: string
  description: string
  text: string
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

export function parseHtmlClip(url: string, html: string): Clip {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url)
  const description =
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    ''
  const article = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html
  const text = stripTags(article).slice(0, 8_000)
  return { url, title, description: decodeEntities(description), text }
}

export function clipToMarkdown(clip: Clip): string {
  return [`# ${clip.title}`, '', `> ${clip.url}`, '', clip.description, '', clip.text, ''].join('\n')
}

export async function clipUrl(
  url: string,
  fetchImpl: (url: string) => Promise<{ text(): Promise<string> }> = fetch,
): Promise<string> {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    throw new Error(`invalid clip URL: ${JSON.stringify(url)}`)
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`refusing to clip a non-http(s) URL (${scheme})`)
  }
  const response = await fetchImpl(url)
  return clipToMarkdown(parseHtmlClip(url, await response.text()))
}
