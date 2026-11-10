import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, inflateSync } from 'node:zlib'
import { CHECK_STATUSES, CHECKLIST, ROW_STATUSES, type RowStatus } from './spec.js'

export const visualDir = (repoRoot: string) => join(repoRoot, 'tmp', 'visual')
const WIDTH = 1280, HEIGHT = 800

export function referencePath(repoRoot: string): string | null {
  const fromEnv = process.env['ENGRAM_VISUAL_REFERENCE']
  if (fromEnv) return existsSync(fromEnv) ? resolve(fromEnv) : null
  const local = join(repoRoot, 'tmp', 'plans', 'grokbot-reference.png')
  if (existsSync(local)) return local
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const main = resolve(common, '..', 'tmp', 'plans', 'grokbot-reference.png')
    return existsSync(main) ? main : null
  } catch { return null }
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// Throws unless the bytes are a complete, decodable WIDTH×HEIGHT PNG.
export function checkPng(buf: Buffer): void {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('not a png')
  let at = 8, ihdr: Buffer | null = null, ended = false
  const idat: Buffer[] = []
  while (at < buf.length) {
    if (at + 12 > buf.length) throw new Error('truncated chunk')
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8)
    if (at + 12 + len > buf.length) throw new Error('truncated chunk')
    const data = buf.subarray(at + 8, at + 8 + len)
    if (crc32(buf.subarray(at + 4, at + 8 + len)) !== buf.readUInt32BE(at + 8 + len)) throw new Error(`bad crc in ${type}`)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') { ended = true; break }
    at += 12 + len
  }
  if (!ihdr || ihdr.length !== 13 || !idat.length || !ended) throw new Error('missing IHDR, IDAT or IEND')
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8]!, color = ihdr[9]!, interlace = ihdr[12]!
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`size ${width}x${height}`)
  const channels = CHANNELS[color]
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || interlace !== 0) throw new Error('unsupported png layout')
  const stride = Math.ceil(width * channels * depth / 8) + 1
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length !== stride * height) throw new Error('image data size mismatch')
  for (let y = 0; y < height; y++) if (raw[y * stride]! > 4) throw new Error('bad filter byte')
}

type Capture = { status: RowStatus[] } | { note: string }

async function readCapture(dir: string, state: string, theme: string): Promise<Capture> {
  try { checkPng(await readFile(join(dir, `${state}-${theme}.png`))) } catch (e) { return { note: `screenshot: ${(e as Error).message}` } }
  try {
    const rows: unknown = JSON.parse(await readFile(join(dir, `${state}-${theme}.metrics.json`), 'utf8'))
    if (!Array.isArray(rows) || rows.length !== CHECKLIST.length) throw new Error('not 18 rows')
    const status = rows.map((row: unknown, i) => {
      const r = row as { row?: unknown; status?: unknown; checks?: unknown }
      if (typeof r !== 'object' || r === null || r.row !== i + 1 || !ROW_STATUSES.includes(r.status as RowStatus) || !Array.isArray(r.checks)) throw new Error(`bad row ${i + 1}`)
      for (const c of r.checks as { what?: unknown; selector?: unknown; expected?: unknown; status?: unknown }[]) {
        if (typeof c?.what !== 'string' || typeof c.selector !== 'string' || typeof c.expected !== 'string' || !CHECK_STATUSES.includes(c.status as never)) throw new Error(`bad check in row ${i + 1}`)
      }
      return r.status as RowStatus
    })
    return { status }
  } catch (e) { return { note: `metrics: ${(e as Error).message}` } }
}

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export async function writeReviewSheet(repoRoot: string): Promise<void> {
  const dir = visualDir(repoRoot)
  await mkdir(dir, { recursive: true })
  const captures = new Map<string, Capture>()
  for (const item of CHECKLIST) for (const state of item.states) for (const theme of ['light', 'dark']) {
    const key = `${state}-${theme}`
    if (!captures.has(key)) captures.set(key, await readCapture(dir, state, theme))
  }
  const rows = CHECKLIST.map(item => {
    const cells = item.states.flatMap(state => ['light', 'dark'].map(theme => {
      const cap = captures.get(`${state}-${theme}`)!
      const status = 'status' in cap ? cap.status[item.row - 1]! : 'not-captured'
      const note = 'note' in cap ? ` <small>${esc(cap.note)}</small>` : ''
      return `<td data-state="${esc(state)}" data-theme="${theme}" data-status="${status}">${esc(`${state} ${theme}`)}: <b class="${status}">${status}</b>${note}</td>`
    }))
    return `<tr data-check-row="${item.row}"><td>${item.row}</td><td>${esc(item.target)}</td><td>${esc(item.assertion)}</td>${cells.join('')}</tr>`
  })
  const reference = referencePath(repoRoot)
  const ref = reference ? `<figure><img src="${esc(pathToFileURL(reference).href)}" alt="reference"><figcaption>reference</figcaption></figure>` : '<figure class="missing">reference image missing</figure>'
  const shots = ['light', 'dark'].map(theme => 'status' in captures.get(`chat-${theme}`)!
    ? `<figure><img src="chat-${theme}.png" alt="chat ${theme}"><figcaption>chat ${theme}</figcaption></figure>`
    : `<figure class="missing">chat ${theme}: not captured</figure>`)
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Bots visual review</title><style>
body{font:13px/1.4 system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:4px 6px;vertical-align:top}
.pass{color:#106b21}.fail,.missing{color:#b3261e}.partial{color:#8a5a00}.deferred,.not-captured{color:#666}small{display:block;color:#666}
.shots{display:flex;gap:12px;margin-top:16px}figure{margin:0;flex:1}img{width:100%;border:1px solid #ddd}figure.missing{padding:24px;border:1px dashed #bbb}
</style></head><body><h1>Bots visual review</h1>
<table><thead><tr><th>#</th><th>Target</th><th>Assertion</th><th colspan="22">State / theme</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>
<div class="shots">${ref}${shots.join('')}</div>
</body></html>
`
  await writeFile(join(dir, 'review.html'), html)
}
