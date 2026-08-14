import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const dir = await mkdtemp(join(tmpdir(), 'engram-doc-'))
    const long = join(dir, 'note.md')
    await writeFile(long, '회의 결론: helm 차트로 통일한다. values 정리는 다음 주.\n추가 메모 줄.')
    expect(await extractDocumentText(long)).toContain('helm 차트')
    const short = join(dir, 'tiny.txt')
    await writeFile(short, 'hi')
    expect(await extractDocumentText(short)).toBeNull()
  })

  it('contentDelta returns only the added lines', async () => {
    const prev = '첫 줄\n둘째 줄\n'
    const next = '첫 줄\n둘째 줄\n셋째 줄 추가됨\n'
    expect(await contentDelta(prev, next)).toBe('셋째 줄 추가됨')
    expect(await contentDelta(null, next)).toContain('첫 줄')
  })
})
