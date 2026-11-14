import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import type { AgentTool } from 'core'

const TIMEOUT_MS = 20_000
const INLINE_BYTES = 2_000_000
const SOURCE_BYTES = 8_000_000
const OUTPUT_BYTES = 50_000_000
const FONT = "html{font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans CJK KR',sans-serif}"
const PNG = '89504e470d0a1a0a'
const NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_. ()-]{0,115}\.(pdf|png)$/iu

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}

// Only real files inside the task folder load; every other request is cancelled.
export function requestAllowed(folder: string, url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && within(folder, realpathSync(fileURLToPath(parsed)))
  } catch { return false }
}

let queue: Promise<unknown> = Promise.resolve()

async function renderNow(folder: string, file: string, kind: 'pdf' | 'png', size: { width: number; height: number }, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  let page = file
  if (extname(file).toLowerCase() === '.md') {
    page = join(folder, `.${randomUUID()}.render.html`)
    await writeFile(page, `<!doctype html><meta charset="utf-8"><style>body{margin:32px;line-height:1.6}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}img{max-width:100%}</style>${marked.parse(await readFile(file, 'utf8'), { async: false })}`, { flag: 'wx' })
  }
  const ses = session.fromPartition(`render-${randomUUID()}`)
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !requestAllowed(folder, details.url) }))
  // A second barrier for anything the request filter does not see.
  await ses.setProxy({ proxyRules: 'http://127.0.0.1:9' })
  ses.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  ses.on('will-download', event => event.preventDefault())
  const win = new BrowserWindow({ show: false, width: size.width, height: size.height, useContentSize: true, webPreferences: { session: ses, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel = () => undefined as void
  try {
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setAudioMuted(true)
    const work = (async () => {
      await win.loadFile(page)
      await contents.insertCSS(FONT, { cssOrigin: 'user' })
      await contents.executeJavaScript('document.fonts.ready.then(() => new Promise(done => setTimeout(done, 150)))')
      if (kind === 'pdf') {
        const data = Buffer.from(await contents.printToPDF({ pageSize: 'A4', printBackground: true }))
        if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The page did not render to a PDF.')
        return data
      }
      const image = await contents.capturePage()
      const data = image.isEmpty() ? Buffer.alloc(0) : image.resize({ width: size.width, height: size.height }).toPNG()
      if (data.subarray(0, 8).toString('hex') !== PNG) throw new Error('The page did not render to an image.')
      return data
    })()
    work.catch(() => undefined)
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Rendering took longer than 20 seconds.')), TIMEOUT_MS)
      cancel = () => reject(new Error('The call was canceled.'))
      signal?.addEventListener('abort', cancel, { once: true })
    })])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    win.destroy()
    if (page !== file) await rm(page, { force: true })
  }
}

// One hidden window at a time: an 8 GB machine does not render pages side by side.
export function renderToBuffer(folder: string, file: string, kind: 'pdf' | 'png', size: { width: number; height: number }, signal?: AbortSignal): Promise<Buffer> {
  const turn = queue.then(() => renderNow(folder, file, kind, size, signal))
  queue = turn.catch(() => undefined)
  return turn
}

export function renderTool(options: {
  folder(): Promise<string>
  source(path: string): Promise<string>
  save(name: string, data: Buffer): Promise<{ markdownLink: string; path: string; sha256: string; taskPath: string }>
  assertActive(): void
}): AgentTool {
  const text = { type: 'string', maxLength: INLINE_BYTES }
  const side = { type: 'integer', minimum: 200, maximum: 4096 }
  return {
    name: 'render_file',
    description: 'Makes a PDF (A4) or a PNG image from HTML or Markdown: give a name ending in .pdf or .png and exactly one of source (an .html or .md file in the task folder), html or markdown. width and height set the PNG size (default 1200x800). Only files in the task folder load and the network is off, so draw charts as inline SVG or on a canvas with inline script, and embed styles. Slides without a presentation tool are HTML pages with page-break-after, rendered to PDF. Quote the returned markdownLink in the answer.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, source: { type: 'string' }, html: text, markdown: text, width: side, height: side } },
    async run(args, context) {
      options.assertActive()
      const name = typeof args.name === 'string' && NAME.test(args.name) ? args.name : ''
      if (!name) throw new Error('Use a plain filename ending in .pdf or .png, without directories.')
      const kind = extname(name).toLowerCase() === '.pdf' ? 'pdf' : 'png'
      const given = (['source', 'html', 'markdown'] as const).filter(key => args[key] !== undefined)
      if (given.length !== 1 || typeof args[given[0]!] !== 'string' || !(args[given[0]!] as string).trim()) throw new Error('Supply exactly one of source, html or markdown.')
      const size = { width: 1200, height: 800 }
      for (const key of ['width', 'height'] as const) {
        if (args[key] === undefined) continue
        if (!Number.isInteger(args[key]) || (args[key] as number) < 200 || (args[key] as number) > 4096) throw new Error('width and height are whole numbers from 200 to 4096.')
        size[key] = args[key] as number
      }
      const folder = await options.folder()
      let file: string
      if (given[0] === 'source') {
        file = await options.source(args.source as string)
        if (!['.html', '.htm', '.md'].includes(extname(file).toLowerCase())) throw new Error('The source must be an .html or .md file.')
        if ((await lstat(file)).size > SOURCE_BYTES) throw new Error('The source is larger than 8 MB.')
      } else {
        const body = args[given[0]!] as string
        if (Buffer.byteLength(body) > INLINE_BYTES) throw new Error('Inline text is limited to 2 MB; write a file and pass source.')
        // An existing file of that name is kept; the source gets a numbered twin.
        file = ''
        for (let count = 1; !file && count < 100; count += 1) {
          const working = join(folder, `${name.slice(0, -4)}${count === 1 ? '' : ` (${count})`}${given[0] === 'html' ? '.html' : '.md'}`)
          await writeFile(working, body, { flag: 'wx' }).then(() => { file = working }, (error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
        }
        if (!file) throw new Error('Too many files in the task folder share this name.')
      }
      const data = await renderToBuffer(folder, file, kind, size, context.signal)
      if (data.length > OUTPUT_BYTES) throw new Error('Generated output exceeds 50 MB.')
      options.assertActive()
      return JSON.stringify({ ...(await options.save(name, data)), completeReadback: true, format: kind, note: 'layout is not verified; text is as written in the source' })
    },
  }
}
