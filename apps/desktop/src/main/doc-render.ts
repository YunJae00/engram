import { shell } from 'electron'
import type { OfficeTheme } from 'core'
import { saveOfficeOutput } from './office-output.js'
import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'

// A document is composed as a file with a real page: a cover, headings that
// carry a style, tables with a shaded header, a footer with a page number.
// The blocks the model sends are laid out here, but every colour and font
// comes from the theme the caller supplies - this file holds none of its own,
// so the result is designed rather than dumped and never locked to one look.

interface DocTable { rows: (string | number)[][] }
interface DocBlock {
  kind: 'title' | 'subtitle' | 'heading' | 'subheading' | 'paragraph' | 'bullets' | 'numbers' | 'table' | 'pagebreak'
  text?: string
  items?: string[]
  table?: DocTable
}
interface DocSpec { title?: string; subject?: string; blocks: DocBlock[]; saveAs?: string; theme: OfficeTheme }

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document'
}

function tableRows(table: DocTable, t: OfficeTheme): TableRow[] {
  return table.rows.map((row, r) =>
    new TableRow({
      tableHeader: r === 0,
      children: row.map((cell) =>
        new TableCell({
          shading: r === 0 ? { type: ShadingType.CLEAR, fill: t.colors.field, color: 'auto' } : r % 2 === 0 ? { type: ShadingType.CLEAR, fill: t.colors.zebra, color: 'auto' } : undefined,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: [new Paragraph({
            alignment: r === 0 || typeof cell === 'number' ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [new TextRun({ text: String(cell), bold: r === 0, color: r === 0 ? t.colors.onField : t.colors.ink, font: t.fonts.body, size: 20 })],
          })],
        }),
      ),
    }),
  )
}

function block(spec: DocBlock, t: OfficeTheme): Paragraph | Table | (Paragraph | Table)[] {
  switch (spec.kind) {
    case 'title':
      return new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 56, color: t.colors.field, font: t.fonts.title })] })
    case 'subtitle':
      return new Paragraph({ spacing: { after: 1600 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: t.colors.accent, space: 8 } }, children: [new TextRun({ text: spec.text ?? '', size: 26, color: t.colors.mute, font: t.fonts.body })] })
    case 'heading':
      return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 30, color: t.colors.field, font: t.fonts.title })] })
    case 'subheading':
      return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: spec.text ?? '', bold: true, size: 24, color: t.colors.ink, font: t.fonts.title })] })
    case 'bullets':
      return (spec.items ?? []).map((item) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: item, size: 22, color: t.colors.ink, font: t.fonts.body })] }))
    case 'numbers':
      return (spec.items ?? []).map((item) => new Paragraph({ numbering: { reference: 'ordered', level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: item, size: 22, color: t.colors.ink, font: t.fonts.body })] }))
    case 'table':
      return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: t.colors.hair }, bottom: { style: BorderStyle.SINGLE, size: 4, color: t.colors.hair }, left: { style: BorderStyle.SINGLE, size: 4, color: t.colors.hair }, right: { style: BorderStyle.SINGLE, size: 4, color: t.colors.hair }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: t.colors.hair }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: t.colors.hair } }, rows: tableRows(spec.table ?? { rows: [] }, t) })
    case 'pagebreak':
      return new Paragraph({ pageBreakBefore: true, children: [] })
    default:
      return new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: spec.text ?? '', size: 22, color: t.colors.ink, font: t.fonts.body })] })
  }
}

export async function renderDoc(spec: DocSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; blocks: number }> {
  const t = spec.theme
  const children: (Paragraph | Table)[] = []
  for (const one of spec.blocks) { const made = block(one, t); if (Array.isArray(made)) children.push(...made); else children.push(made) }
  // The footer carries a centred page number in the document's quiet grey.
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], color: t.colors.mute, size: 18, font: t.fonts.body })] })] })
  const doc = new Document({
    creator: 'Engram',
    title: spec.title ?? '',
    background: { color: t.colors.paper },
    numbering: { config: [{ reference: 'ordered', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] }] },
    styles: { default: { document: { run: { font: t.fonts.body, size: 22, color: t.colors.ink } } } },
    sections: [{ footers: { default: footer }, children }],
  })
  const path = await saveOfficeOutput(sanitize(spec.title ?? 'document'), '.docx', await Packer.toBuffer(doc), spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, blocks: spec.blocks.length }
}
