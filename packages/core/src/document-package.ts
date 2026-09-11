import { createHash } from 'node:crypto'
import { posix, extname } from 'node:path'
import { fromBuffer } from 'yauzl'
import JSZip from 'jszip'
import { DOMParser, type Document } from '@xmldom/xmldom'
import { validateWorkbookFormula } from './file-workbook.js'
import { DOCUMENT_BYTES, DOCUMENT_EXTENSIONS } from './document-tools.js'

const EXPANDED_BYTES = 32_000_000
const PART_BYTES = 2_000_000
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OFFICE_RELS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']
export const hashBytes = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export type DocumentPackage = Map<string, Buffer>
export type XmlEdit = { part: string; expectedSha256: string; before: string; after: string }

export function partName(name: unknown): string {
  if (typeof name !== 'string' || name.length > 300 || !name || name.split('/').some((piece) => !piece || piece === '.' || piece === '..') || /[\\:%?#]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) throw new Error('Use an exact relative document part name from the manifest.')
  return name
}

export function xmlText(bytes: Buffer): string {
  if (bytes.length > PART_BYTES) throw new Error('XML part exceeds 2 MB.')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function parseXml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DTD and entities are not supported.')
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) < 32 && !'\t\n\r'.includes(text[index]!)) throw new Error('Invalid XML character.')
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(message) } }).parseFromString(text, 'application/xml')
  if (!document.documentElement) throw new Error('XML requires a document element.')
  if (Array.from(document.childNodes).some((node) => node.nodeType === 7 && node.nodeName !== 'xml')) throw new Error('Processing instructions are not supported.')
  return document
}

// Read sequentially, checking declared and streamed sizes before allocating a
// complete part. Archive paths never become host filesystem paths.
export async function readPackage(bytes: Buffer, signal?: AbortSignal): Promise<DocumentPackage> {
  if (bytes.length > DOCUMENT_BYTES) throw new Error('Document exceeds 8 MB.')
  signal?.throwIfAborted()
  const parts = new Map<string, Buffer>()
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Cannot read document package.')); return }
      let count = 0
      let expanded = 0
      const names = new Set<string>()
      const fail = (error: unknown) => { zip.close(); signal?.removeEventListener('abort', abort); reject(error) }
      const abort = () => fail(signal?.reason ?? new Error('Cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      zip.on('error', fail)
      zip.on('end', () => { signal?.removeEventListener('abort', abort); resolve() })
      zip.on('entry', (entry) => {
        try {
          signal?.throwIfAborted()
          const name = partName(entry.fileName.replace(/\/$/, ''))
          if (++count > 2000 || names.has(name.toLowerCase())) throw new Error('Too many or duplicate document parts.')
          names.add(name.toLowerCase())
          const mode = entry.externalFileAttributes >>> 16
          if ((entry.generalPurposeBitFlag & 1) || (mode & 0xf000) === 0xa000) throw new Error('Encrypted and linked archive entries are not supported.')
          expanded += entry.uncompressedSize
          if (entry.uncompressedSize > EXPANDED_BYTES || expanded > EXPANDED_BYTES) throw new Error('Expanded document exceeds 32 MB.')
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) { fail(error ?? new Error('Cannot read part.')); return }
            const chunks: Buffer[] = []
            let size = 0
            stream.on('error', fail)
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (signal?.aborted || size > entry.uncompressedSize || size > EXPANDED_BYTES) { stream.destroy(new Error('Document read cancelled or size changed.')); return }
              chunks.push(chunk)
            })
            stream.on('end', () => {
              if (size !== entry.uncompressedSize) { fail(new Error('Part size did not match.')); return }
              parts.set(name, Buffer.concat(chunks, size))
              zip.readEntry()
            })
          })
        } catch (error) { fail(error) }
      })
      zip.readEntry()
    })
  })
  // CRC validation is safe after the bounded pass above has checked every part.
  await JSZip.loadAsync(bytes, { checkCRC32: true })
  signal?.throwIfAborted()
  return parts
}

function relationshipOwner(name: string): string {
  if (name === '_rels/.rels') return ''
  if (!name.includes('/_rels/') || !name.endsWith('.rels')) throw new Error('Invalid relationship part path.')
  return name.replace('/_rels/', '/').slice(0, -5)
}

function internalTarget(owner: string, target: string): string {
  const decoded = decodeURIComponent(target.split('#')[0]!)
  const name = decoded.startsWith('/') ? decoded.slice(1) : posix.join(owner ? posix.dirname(owner) : '', decoded)
  return partName(name)
}

export function validatePackage(parts: DocumentPackage, extension: string): void {
  const main = extension === '.docx' ? ['word/document.xml', 'document', 'wordprocessingml']
    : extension === '.pptx' ? ['ppt/presentation.xml', 'presentation', 'presentationml'] : ['xl/workbook.xml', 'workbook', 'spreadsheetml']
  if (!DOCUMENT_EXTENSIONS.includes(extension) || !parts.has(main[0]!) || !parts.has('[Content_Types].xml') || !parts.has('_rels/.rels')) throw new Error('The document package does not match its extension.')
  const documents = new Map<string, Document>()
  for (const [name, bytes] of parts) {
    if (/(?:^|\/)(?:vbaProject\.bin|activeX|_xmlsignatures)(?:\/|$)/i.test(name)) throw new Error('Macros, active controls and signed packages are not supported.')
    if (/\.(xml|rels)$/i.test(name)) documents.set(name, parseXml(xmlText(bytes)))
  }
  const root = documents.get(main[0]!)!.documentElement!
  if (root.localName !== main[1] || ![`http://schemas.openxmlformats.org/${main[2]}/2006/main`, `http://purl.oclc.org/ooxml/${main[2]}/main`].includes(root.namespaceURI ?? '')) throw new Error('The main document XML has the wrong root.')
  const types = documents.get('[Content_Types].xml')!.documentElement!
  if (types.localName !== 'Types' || types.namespaceURI !== CONTENT_TYPES) throw new Error('Invalid package content types.')
  const overrides = new Map<string, string>()
  const defaults = new Map<string, string>()
  for (const entry of Array.from(types.childNodes)) {
    if (entry.nodeType !== 1) continue
    const element = entry as typeof types
    const contentType = element.getAttribute('ContentType') ?? ''
    if (/macroEnabled|vbaProject|activeX/i.test(contentType)) throw new Error('Executable document content is not supported.')
    if (element.namespaceURI !== CONTENT_TYPES) throw new Error('Unknown content type namespace.')
    if (element.localName === 'Override') {
      const name = partName((element.getAttribute('PartName') ?? '').replace(/^\//, ''))
      if (!parts.has(name) || overrides.has(name)) throw new Error('Content type refers to a missing or duplicate part.')
      overrides.set(name, contentType)
    } else if (element.localName === 'Default') {
      const extension = element.getAttribute('Extension') ?? ''
      if (!extension || defaults.has(extension)) throw new Error('Invalid or duplicate default content type.')
      defaults.set(extension, contentType)
    }
    else throw new Error('Unknown content type entry.')
  }
  const mainType = extension === '.docx' ? 'wordprocessingml.document' : extension === '.pptx' ? 'presentationml.presentation' : 'spreadsheetml.sheet'
  if (overrides.get(main[0]!) !== `application/vnd.openxmlformats-officedocument.${mainType}.main+xml`) throw new Error('The main content type does not match the document format.')
  for (const name of parts.keys()) if (name !== '[Content_Types].xml' && !(overrides.get(name) || defaults.get(name.endsWith('.rels') ? 'rels' : extname(name).slice(1)))) throw new Error(`Missing content type for ${name}.`)
  const relationships = new Map<string, Set<string>>()
  let rootMain = false
  for (const [name, document] of documents) {
    if (!name.endsWith('.rels')) continue
    const root = document.documentElement!
    if (root.localName !== 'Relationships' || root.namespaceURI !== PACKAGE_RELS) throw new Error('Invalid relationship XML.')
    const owner = relationshipOwner(name)
    if (owner && !parts.has(owner)) throw new Error('Relationship owner is missing.')
    const ids = new Set<string>()
    for (const entry of Array.from(root.childNodes)) {
      if (entry.nodeType !== 1) continue
      const element = entry as typeof root
      const id = element.getAttribute('Id') ?? ''
      const type = element.getAttribute('Type') ?? ''
      if (element.localName !== 'Relationship' || element.namespaceURI !== PACKAGE_RELS || !id || ids.has(id) || !type) throw new Error('Invalid or duplicate relationship.')
      ids.add(id)
      const target = element.getAttribute('Target') ?? ''
      if (!target) throw new Error('Relationship target is missing.')
      if (element.getAttribute('TargetMode') === 'External') continue
      const resolved = internalTarget(owner, target)
      if (!parts.has(resolved)) throw new Error(`Relationship target is missing: ${resolved}.`)
      if (!owner && type.endsWith('/officeDocument') && resolved === main[0]) rootMain = true
    }
    relationships.set(owner, ids)
  }
  if (!rootMain) throw new Error('The package root does not reference its main document.')
  for (const [name, document] of documents) {
    if (name.endsWith('.rels')) continue
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      for (const attr of Array.from(element.attributes)) {
        if (OFFICE_RELS.includes(attr.namespaceURI ?? '') && !relationships.get(name)?.has(attr.value)) throw new Error(`Missing relationship ${attr.value} in ${name}.`)
      }
    }
  }
}

function activeContent(document: Document): Set<string> {
  const result = new Set<string>()
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (element.localName === 'Relationship' && element.getAttribute('TargetMode') === 'External') result.add(`external:${element.getAttribute('Target')}`)
    if (['instrText', 'fldSimple', 'OLEObject', 'object', 'altChunk', 'attachedTemplate', 'connection', 'externalLink', 'control'].includes(element.localName ?? '')) result.add(`active:${element.toString()}`)
  }
  return result
}

export async function editPackage(parts: DocumentPackage, edits: XmlEdit[], extension: string, signal?: AbortSignal) {
  const next = new Map(parts)
  const changed = new Set<string>()
  for (const edit of edits) {
    signal?.throwIfAborted()
    const name = partName(edit.part)
    if (!/\.(xml|rels)$/i.test(name)) throw new Error('Only existing XML parts may be edited; binary parts stay unchanged.')
    const original = parts.get(name)
    if (!original || hashBytes(original) !== edit.expectedSha256) throw new Error('Read the part again; its revision is missing or changed.')
    const text = xmlText(next.get(name)!)
    if (!edit.before || text.indexOf(edit.before) < 0 || text.indexOf(edit.before) !== text.lastIndexOf(edit.before)) throw new Error('The old XML must match exactly once; read a more precise fragment.')
    const after = text.replace(edit.before, () => edit.after)
    const bytes = Buffer.from(after)
    const document = parseXml(xmlText(bytes))
    const beforeDocument = parseXml(xmlText(original))
    const existing = activeContent(beforeDocument)
    if ([...activeContent(document)].some((value) => !existing.has(value))) throw new Error('New external links or document fields require the live application.')
    if (extension === '.xlsx') {
      const oldFormulas = new Set(Array.from(beforeDocument.getElementsByTagNameNS('*', 'f')).map((node) => node.textContent))
      for (const formula of Array.from(document.getElementsByTagNameNS('*', 'f'))) if (!oldFormulas.has(formula.textContent)) validateWorkbookFormula(formula.textContent ?? '')
    }
    next.set(name, bytes)
    changed.add(name)
  }
  validatePackage(next, extension)
  const zip = new JSZip()
  for (const [name, bytes] of next) zip.file(name, bytes, { date: new Date('2000-01-01T00:00:00Z'), createFolders: false })
  const stream = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 }, streamFiles: true })
  const chunks: Buffer[] = []
  let length = 0
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject)
    stream.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > DOCUMENT_BYTES || signal?.aborted) {
        stream.pause()
        reject(new Error('Output cancelled or exceeds 8 MB.'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', resolve)
  })
  const bytes = Buffer.concat(chunks, length)
  const readback = await readPackage(bytes, signal)
  for (const [name, expected] of next) if (!readback.get(name)?.equals(expected)) throw new Error(`Package readback changed ${name}. Nothing was saved.`)
  if (readback.size !== next.size) throw new Error('Package part count changed unexpectedly.')
  return { bytes, changedParts: [...changed], preservedParts: next.size - changed.size }
}
