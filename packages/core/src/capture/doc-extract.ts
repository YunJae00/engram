import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { readPackage, validatePackage, type DocumentPackage } from '../document-package.js'
import { DOCUMENT_BYTES, DOCUMENT_EXTENSIONS } from '../document-tools.js'

// Document content extraction — the heart of non-developer capture
// when a document the user is working on is saved,
// its TEXT comes out here so the librarian can remember what the work was
// about. Local files, local parsing, nothing leaves the machine.
//
// Formats by presence on Korean office machines: docx/xlsx/pptx (Office),
// pdf (digital-text only — scanned pages yield nothing and OCR is out of
// scope by policy), hwpx (the KS X 6101 zip+XML format; the legacy binary
// .hwp is NOT parsed — partial extractors mangle tables and the honest move
// is to capture the skeleton only), and the plain-text family.

export type ExtractableKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'hwpx' | 'text'
// unbounded: every sheet, page and character, for a reader that pages the result itself.
export interface DocumentExtractOptions { minLength?: number; onLimit?(message: string): void; unbounded?: boolean; bytes?: Buffer; signal?: AbortSignal }

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.log', '.json'])

export function extractableKind(path: string): ExtractableKind | null {
  const ext = extname(path).toLowerCase()
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.hwpx') return 'hwpx'
  if (TEXT_EXTS.has(ext)) return 'text'
  return null
}

// Office autosave writes temp siblings (~$foo.docx, foo.tmp) that must never
// be read as documents.
export function isTransientArtifact(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  return name.startsWith('~$') || name.startsWith('.~') || name.endsWith('.tmp') || name.endsWith('.crdownload') || name.endsWith('.part')
}

const MAX_CHARS = 60_000

function clip(text: string, options: DocumentExtractOptions): string {
  const squeezed = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (options.unbounded) return squeezed
  if (squeezed.length > MAX_CHARS) options.onLimit?.('Text extraction is limited to 60,000 characters.')
  return squeezed.length > MAX_CHARS ? `${squeezed.slice(0, MAX_CHARS)}\n…(clipped)` : squeezed
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value ?? ''
}

async function extractXlsx(bytes: Buffer, options: DocumentExtractOptions): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, { type: 'buffer' })
  const parts: string[] = []
  const sheets = options.unbounded ? Infinity : 12, chars = options.unbounded ? Infinity : 8_000
  if (wb.SheetNames.length > sheets) options.onLimit?.('Only the first 12 worksheets were extracted.')
  for (const name of wb.SheetNames.slice(0, sheets)) {
    options.signal?.throwIfAborted()
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1')
    if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 1_000_000) throw new Error('Worksheet range is too large to extract safely.')
    const csv = XLSX.utils.sheet_to_csv(sheet).trim()
    if (csv.length > chars) options.onLimit?.(`Worksheet ${JSON.stringify(name)} was limited to 8,000 characters.`)
    if (csv) parts.push(`## ${name}\n${csv.slice(0, chars)}`)
  }
  return parts.join('\n\n')
}

function zipXmlTexts(parts: DocumentPackage, entryMatch: RegExp): string {
  return [...parts].filter(([name]) => entryMatch.test(name))
    .map(([, bytes]) => bytes.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('\n\n')
}

async function extractPdf(bytes: Buffer, options: DocumentExtractOptions): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
  try {
    const doc = await loading.promise
    const parts: string[] = []
    const pages = options.unbounded ? doc.numPages : Math.min(doc.numPages, 40)
    if (doc.numPages > pages) options.onLimit?.('Only the first 40 PDF pages were extracted.')
    for (let i = 1; i <= pages; i++) {
      options.signal?.throwIfAborted()
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return parts.join('\n')
  } finally {
    await loading.destroy()
  }
}

// One entry point: kind-dispatched, clipped, throw-free (a document that
// cannot be read yields null — the caller records the skeleton only).
export async function extractDocumentText(path: string, options: DocumentExtractOptions = {}): Promise<string | null> {
  const kind = extractableKind(path)
  if (!kind || isTransientArtifact(path)) return null
  try {
    options.signal?.throwIfAborted()
    const bytes = options.bytes ?? await readFile(path)
    if (bytes.length > DOCUMENT_BYTES) return null
    const parts = kind !== 'text' && kind !== 'pdf' ? await readPackage(bytes, options.signal) : undefined
    if (parts && options.unbounded && DOCUMENT_EXTENSIONS.includes(extname(path).toLowerCase())) validatePackage(parts, extname(path).toLowerCase())
    let text = ''
    if (kind === 'text') {
      const raw = bytes.toString('utf8')
      if (!options.unbounded && raw.length > MAX_CHARS * 2) options.onLimit?.('Source text was limited before normalization.')
      text = options.unbounded ? raw : raw.slice(0, MAX_CHARS * 2)
    }
    else if (kind === 'docx') text = await extractDocx(bytes)
    else if (kind === 'xlsx') text = await extractXlsx(bytes, options)
    else if (kind === 'pptx') text = zipXmlTexts(parts!, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/)
    else if (kind === 'hwpx') text = zipXmlTexts(parts!, /^Contents\/section\d+\.xml$/i)
    else if (kind === 'pdf') text = await extractPdf(bytes, options)
    options.signal?.throwIfAborted()
    const clipped = clip(text, options)
    return clipped.length >= Math.max(1, options.minLength ?? (options.unbounded ? 1 : 20)) ? clipped : null
  } catch {
    return null
  }
}

// "What changed since the last save" — the memory-worthy delta, not the whole
// document again. Line-level diff, added lines only (removals are noise for a
// work journal), capped.
export async function contentDelta(previous: string | null, current: string): Promise<string> {
  if (!previous) return current.slice(0, 4_000)
  const { diffLines } = await import('diff')
  const added = diffLines(previous, current)
    .filter((part) => part.added)
    .map((part) => part.value.trim())
    .filter(Boolean)
  return added.join('\n').slice(0, 4_000)
}
