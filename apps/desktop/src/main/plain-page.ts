import type { WebPage } from 'core'
import { classifyWall } from './page-wall.js'

const NO_ROOM = /not enough free memory/i
const PLAIN_MAX_BYTES = 2_000_000
const PLAIN_TIMEOUT_MS = 10_000
const TEXT_CAP = 60_000
const PLAIN_TEXT_MIN = 200
const LINKS_MAX = 200

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
  const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
})
const words = (html: string): string => decode(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t\r\f\v]+/g, ' ').trim()

export function plainPage(html: string, url: string): WebPage {
  const title = words(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const links: { text: string; url: string }[] = []
  const seen = new Set<string>()
  for (const part of [body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, ' '), body]) for (const match of part.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const text = words(match[4] ?? '')
    if (!text || links.length >= LINKS_MAX) continue
    try {
      const to = new URL(decode(match[1] ?? match[2] ?? match[3] ?? ''), url), key = `${to.href}\n${text}`
      if (/^https?:$/.test(to.protocol) && !seen.has(key)) { seen.add(key); links.push({ text: text.slice(0, 160), url: to.href }) }
    } catch {}
  }
  const text = decode(body.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/table)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim()
  let wall: ReturnType<typeof classifyWall> = null
  try { wall = classifyWall(url, title, text, /<input\b[^>]*\btype\s*=\s*["']?password/i.test(html)) } catch {}
  return { url, requestedUrl: url, title, ...(wall ? { wall } : {}), text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n[Page extract truncated; absence from this extract does not establish absence from the page.]` : text, links }
}

export async function fetchPlainPage(url: string, signal: AbortSignal | undefined, fetcher: (url: string, init: RequestInit) => Promise<Response>): Promise<WebPage> {
  const limit = AbortSignal.timeout(PLAIN_TIMEOUT_MS)
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, limit]) : limit, credentials: 'omit', redirect: 'follow', headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' } })
  const type = response.headers.get('content-type') ?? ''
  if (type && !/html|text\/plain|xml/i.test(type)) throw new Error(`${url} is not a page of text (${type.split(';')[0]}).`)
  const parts: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  try {
    while (reader && size < PLAIN_MAX_BYTES) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length }
  } finally { await reader?.cancel().catch(() => undefined) }
  const bytes = Buffer.concat(parts).subarray(0, PLAIN_MAX_BYTES)
  let html: string
  try { html = new TextDecoder(/charset=["']?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8').decode(bytes) } catch { html = new TextDecoder().decode(bytes) }
  const page = plainPage(html, response.url || url)
  return { ...page, requestedUrl: url, ...(response.status >= 400 ? { status: response.status } : {}) }
}

export async function tabOrPlain<T>(tab: () => Promise<T>, plain: (() => Promise<WebPage>) | undefined, signal?: AbortSignal, waitMs = 8_000, stepMs = 1_000): Promise<{ tab: T } | { read: WebPage }> {
  let refusal: unknown
  try { return { tab: await tab() } } catch (error) { if (!NO_ROOM.test(String(error instanceof Error ? error.message : error))) throw error; refusal = error }
  const read = plain ? await plain().catch(() => undefined) : undefined
  if (read && read.text.length >= PLAIN_TEXT_MIN && !read.wall) return { read }
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await new Promise(resolve => setTimeout(resolve, stepMs))
    signal?.throwIfAborted()
    try { return { tab: await tab() } } catch (error) { if (!NO_ROOM.test(String(error instanceof Error ? error.message : error))) throw error; refusal = error }
  }
  if (read?.text.trim() || read?.wall) return { read }
  throw refusal
}
