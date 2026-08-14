import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

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

function clip(text: string): string {
  const squeezed = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return squeezed.length > MAX_CHARS ? `${squeezed.slice(0, MAX_CHARS)}\n…(clipped)` : squeezed
}

async function extractDocx(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path })
  return result.value ?? ''
}

async function extractXlsx(path: string): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await readFile(path), { type: 'buffer' })
  const parts: string[] = []
  for (const name of wb.SheetNames.slice(0, 12)) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet).trim()
    if (csv) parts.push(`## ${name}\n${csv.slice(0, 8_000)}`)
  }
  return parts.join('\n\n')
}

// pptx and hwpx are both zip-of-XML — one tiny inflater serves both, keeping
// two heavyweight dependencies out of core. Central-directory walk, DEFLATE
// via node:zlib, XML tags stripped to whitespace.
async function zipXmlTexts(path: string, entryMatch: RegExp): Promise<string> {
  const { inflateRawSync } = await import('node:zlib')
  const buf = await readFile(path)
  const parts: string[] = []
  // End of central directory → walk entries.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) return ''
  let offset = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    if (entryMatch.test(name)) {
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      try {
        const xml = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8')
        const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (text) parts.push(text)
      } catch {
        /* torn entry — skip */
      }
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return parts.join('\n\n')
}

async function extractPdf(path: string): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true }).promise
  const parts: string[] = []
  const pages = Math.min(doc.numPages, 40)
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  await (doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => void }).destroy?.()
  return parts.join('\n')
}

// One entry point: kind-dispatched, clipped, throw-free (a document that
// cannot be read yields null — the caller records the skeleton only).
export async function extractDocumentText(path: string): Promise<string | null> {
  const kind = extractableKind(path)
  if (!kind || isTransientArtifact(path)) return null
  try {
    let text = ''
    if (kind === 'text') text = (await readFile(path, 'utf8')).slice(0, MAX_CHARS * 2)
    else if (kind === 'docx') text = await extractDocx(path)
    else if (kind === 'xlsx') text = await extractXlsx(path)
    else if (kind === 'pptx') text = await zipXmlTexts(path, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/)
    else if (kind === 'hwpx') text = await zipXmlTexts(path, /^Contents\/section\d+\.xml$/i)
    else if (kind === 'pdf') text = await extractPdf(path)
    const clipped = clip(text)
    return clipped.length >= 20 ? clipped : null
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
