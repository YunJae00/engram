import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentDelta, extractDocumentText, extractableKind, isTransientArtifact } from '../src/capture/doc-extract.js'

describe('doc-extract', () => {
  it('classifies formats and rejects transients', () => {
    expect(extractableKind('a/보고서.docx')).toBe('docx')
    expect(extractableKind('a/견적.xlsx')).toBe('xlsx')
    expect(extractableKind('a/발표.pptx')).toBe('pptx')
    expect(extractableKind('a/계약.hwpx')).toBe('hwpx')
    expect(extractableKind('a/스캔.hwp')).toBeNull()
    expect(extractableKind('a/메모.txt')).toBe('text')
    expect(isTransientArtifact('a/~$보고서.docx')).toBe(true)
    expect(isTransientArtifact('a/받는중.crdownload')).toBe(true)
    expect(isTransientArtifact('a/보고서.docx')).toBe(false)
  })

  it('extracts plain text and returns null for too-short content', async () => {
    await mkdir('tmp', { recursive: true })
    const dir = await mkdtemp(resolve('tmp/engram-doc-'))
    const long = join(dir, 'note.md')
    await writeFile(long, '회의 결론: helm 차트로 통일한다. values 정리는 다음 주.\n추가 메모 줄.')
    expect(await extractDocumentText(long)).toContain('helm 차트')
    const short = join(dir, 'tiny.txt')
    await writeFile(short, 'hi')
    expect(await extractDocumentText(short)).toBeNull()
    expect(await extractDocumentText(short, { minLength: 1 })).toBe('hi')
  })

  it('reports worksheet count and text truncation to attachment callers', async () => {
    await mkdir('tmp', { recursive: true })
    const dir = await mkdtemp(resolve('tmp/engram-doc-'))
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    for (let i = 0; i < 13; i++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[i === 0 ? 'x'.repeat(9_000) : '42']]), `Sheet${i}`)
    const path = join(dir, 'many.xlsx')
    await writeFile(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const limits: string[] = []
    const text = await extractDocumentText(path, { minLength: 1, onLimit: message => limits.push(message) })
    expect(text).toContain('Sheet11')
    expect(text).not.toContain('Sheet12')
    expect(limits).toContain('Only the first 12 worksheets were extracted.')
    expect(limits).toContain('Worksheet "Sheet0" was limited to 8,000 characters.')
  })

  it('contentDelta returns only the added lines', async () => {
    const prev = '첫 줄\n둘째 줄\n'
    const next = '첫 줄\n둘째 줄\n셋째 줄 추가됨\n'
    expect(await contentDelta(prev, next)).toBe('셋째 줄 추가됨')
    expect(await contentDelta(null, next)).toContain('첫 줄')
  })
})
