import { shell } from 'electron'
import { saveOfficeOutput } from './office-output.js'
import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'

// A document is composed as a file with a real page: a cover, headings that
// carry a style, tables with a shaded header, a footer with a page number.
// The blocks the model sends are laid out here, not typed into an open Word
// window one line at a time, so the result is designed rather than dumped.

interface DocTable { rows: (string | number)[][] }
interface DocBlock {
  kind: 'title' | 'subtitle' | 'heading' | 'subheading' | 'paragraph' | 'bullets' | 'numbers' | 'table' | 'pagebreak'
  text?: string
  items?: string[]
  table?: DocTable
}
interface DocSpec { title?: string; subject?: string; blocks: DocBlock[]; saveAs?: string }

const FIELD = '1F3B5B'
const ACCENT = 'C0603B'
const INK = '2B2B33'
const MUTE = '6B7280'
const HAIR = 'D8DCE4'
const ZEBRA = 'F4F6FA'
const BODY = 'Segoe UI'
const HEAD = 'Segoe UI Semibold'

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document'
}

function tableRows(table: DocTable): TableRow[] {
  return table.rows.map((row, r) =>
    new TableRow({
      tableHeader: r === 0,
      children: row.map((cell) =>
        new TableCell({
          shading: r === 0 ? { type: ShadingType.CLEAR, fill: FIELD, color: 'auto' } : r % 2 === 0 ? { type: ShadingType.CLEAR, fill: ZEBRA, color: 'auto' } : undefined,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: [new Paragraph({
            alignment: r === 0 || typeof cell === 'number' ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [new TextRun({ text: String(cell), bold: r === 0, color: r === 0 ? 'FFFFFF' : INK, font: BODY, size: 20 })],
          })],
        }),
      ),
    }),
  )
}

function block(spec: DocBlock): Paragraph | Table | (Paragraph | Table)[] {
  switch (spec.kind) {
    case 'title':
      return new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 56, color: FIELD, font: HEAD })] })
    case 'subtitle':
      return new Paragraph({ spacing: { after: 1600 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 8 } }, children: [new TextRun({ text: spec.text ?? '', size: 26, color: MUTE, font: BODY })] })
    case 'heading':
      return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 30, color: FIELD, font: HEAD })] })
    case 'subheading':
      return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 24, color: INK, font: HEAD })] })
    case 'bullets':
      return (spec.items ?? []).map((item) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: item, size: 22, color: INK, font: BODY })] }))
    case 'numbers':
      return (spec.items ?? []).map((item) => new Paragraph({ numbering: { reference: 'ordered', level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: item, size: 22, color: INK, font: BODY })] }))
    case 'table':
      return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, left: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, right: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: HAIR }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: HAIR } }, rows: tableRows(spec.table ?? { rows: [] }) })
    case 'pagebreak':
      return new Paragraph({ pageBreakBefore: true, children: [] })
    default:
      return new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: spec.text ?? '', size: 22, color: INK, font: BODY })] })
  }
}

export async function renderDoc(spec: DocSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; blocks: number }> {
  const children: (Paragraph | Table)[] = []
  for (const one of spec.blocks) { const made = block(one); if (Array.isArray(made)) children.push(...made); else children.push(made) }
  // The footer carries a centred page number in the document's quiet grey.
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], color: MUTE, size: 18, font: BODY })] })] })
  const doc = new Document({
    creator: 'Engram',
    title: spec.title ?? '',
    numbering: { config: [{ reference: 'ordered', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] }] },
    styles: { default: { document: { run: { font: BODY, size: 22, color: INK } } } },
    sections: [{ footers: { default: footer }, children }],
  })
  const path = await saveOfficeOutput(sanitize(spec.title ?? 'document'), '.docx', await Packer.toBuffer(doc), spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, blocks: spec.blocks.length }
}
