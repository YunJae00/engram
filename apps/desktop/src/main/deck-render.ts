import { shell } from 'electron'
import { auditDeck, deckBodyLayout, describeDeckFindings } from 'core'
import { saveOfficeOutput } from './office-output.js'
import PptxGenJS from 'pptxgenjs'

// A deck is written as a file, not clicked into PowerPoint one shape at a
// time: every slide's type, colour and placement is decided here, so what
// comes out is designed rather than dropped into a blank template. The file
// then opens in whatever the person reads .pptx with.

interface DeckSeries { name: string; values: number[] }
interface DeckChart { type?: 'column' | 'line' | 'bar' | 'pie'; categories: string[]; series: DeckSeries[] }
interface DeckTable { rows: (string | number)[][] }
interface DeckSlide { title: string; subtitle?: string; bullets?: string[]; table?: DeckTable; chart?: DeckChart; notes?: string }
interface DeckSpec { slides: DeckSlide[]; saveAs?: string; title?: string }

// One restrained scheme: a deep field, a single warm accent, and quiet greys.
// Nothing shouts; the content carries the slide.
const INK = '2B2B33'
const FIELD = '1F3B5B'
const ACCENT = 'C0603B'
const MUTE = '6B7280'
const HAIR = 'D8DCE4'
const ZEBRA = 'F4F6FA'
const PAPER = 'FFFFFF'
const TITLE_FONT = 'Segoe UI Semibold'
const BODY_FONT = 'Segoe UI'
const W = 13.33
const H = 7.5
const MARGIN = 0.7

function sanitize(name: string): string {
  return (name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'deck')
}

function chartType(pptx: PptxGenJS, type: DeckChart['type']): PptxGenJS.CHART_NAME {
  if (type === 'line') return pptx.ChartType.line
  if (type === 'pie') return pptx.ChartType.pie
  return pptx.ChartType.bar
}

function titleSlide(pptx: PptxGenJS, spec: DeckSpec): void {
  const first = spec.slides[0]!
  const slide = pptx.addSlide()
  slide.background = { color: FIELD }
  slide.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 3.5, w: 1.4, h: 0.09, fill: { color: ACCENT } })
  slide.addText(first.title, { x: MARGIN, y: 1.4, w: W - MARGIN * 2, h: 1.9, fontFace: TITLE_FONT, fontSize: 40, color: PAPER, bold: true, align: 'left', valign: 'bottom', fit: 'shrink' })
  if (first.subtitle) slide.addText(first.subtitle, { x: MARGIN, y: 3.8, w: W - MARGIN * 2, h: 2.0, fontFace: BODY_FONT, fontSize: 18, color: 'C9D2E0', align: 'left', fit: 'shrink' })
  if (first.notes) slide.addNotes(first.notes)
}

function contentFrame(pptx: PptxGenJS, slide: DeckSlide, index: number, total: number): PptxGenJS.Slide {
  const s = pptx.addSlide()
  s.background = { color: PAPER }
  s.addText(slide.title, { x: MARGIN, y: 0.35, w: W - MARGIN * 2, h: 1.0, fontFace: TITLE_FONT, fontSize: 26, color: FIELD, bold: true, fit: 'shrink', margin: 0 })
  s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.42, w: 1.1, h: 0.06, fill: { color: ACCENT } })
  if (slide.subtitle) s.addText(slide.subtitle, { x: MARGIN, y: 1.5, w: W - MARGIN * 2, h: deckBodyLayout(slide).subtitleHeight, fontFace: BODY_FONT, fontSize: 14, color: MUTE, italic: true, margin: 0 })
  s.addText(`${index} / ${total}`, { x: W - MARGIN - 1.2, y: H - 0.55, w: 1.2, h: 0.3, fontFace: BODY_FONT, fontSize: 9, color: MUTE, align: 'right' })
  return s
}

function addBullets(slide: PptxGenJS.Slide, bullets: string[], top: number, height: number): void {
  slide.addText(
    bullets.map((text) => ({ text, options: { bullet: { code: '25AA', indent: 18 }, color: INK, fontSize: 16, paraSpaceAfter: 10, breakLine: true } })),
    { x: MARGIN, y: top, w: W - MARGIN * 2, h: height, fontFace: BODY_FONT, valign: 'top', margin: 0 },
  )
}

function addTable(pptx: PptxGenJS, slide: PptxGenJS.Slide, table: DeckTable, top: number, rowHeights: number[]): void {
  const rows = table.rows.map((row, r) =>
    row.map((cell) => ({
      text: String(cell),
      options: {
        fontFace: BODY_FONT, fontSize: 13, color: r === 0 ? PAPER : INK, bold: r === 0,
        fill: { color: r === 0 ? FIELD : r % 2 === 0 ? ZEBRA : PAPER },
        align: (r === 0 || typeof cell === 'number' ? 'center' : 'left') as PptxGenJS.HAlign,
        valign: 'middle' as PptxGenJS.VAlign, margin: 4,
      },
    })),
  )
  slide.addTable(rows, { x: MARGIN, y: top, w: W - MARGIN * 2, border: { type: 'solid', color: HAIR, pt: 1 }, autoPage: false, rowH: rowHeights })
}

function addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, chart: DeckChart, top: number): void {
  const type = chartType(pptx, chart.type)
  const palette = [FIELD, ACCENT, '3C6B66', 'A9832F', '6B7280']
  if (chart.type === 'pie') {
    slide.addChart(type, [{ name: chart.series[0]!.name, labels: chart.categories, values: chart.series[0]!.values }], {
      x: MARGIN, y: top, w: W - MARGIN * 2, h: H - top - 0.7, showLegend: true, legendPos: 'r', chartColors: palette, showPercent: true, dataLabelColor: PAPER, fontFace: BODY_FONT,
    })
    return
  }
  const data = chart.series.map((series) => ({ name: series.name, labels: chart.categories, values: series.values }))
  slide.addChart(type, data, {
    x: MARGIN, y: top, w: W - MARGIN * 2, h: H - top - 0.7,
    barDir: chart.type === 'bar' ? 'bar' : 'col',
    chartColors: palette, showLegend: chart.series.length > 1, legendPos: 'b', fontFace: BODY_FONT,
    catAxisLabelColor: MUTE, valAxisLabelColor: MUTE, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    showValue: false, valGridLine: { style: 'solid', color: HAIR, size: 1 },
  })
}

// Renders the deck and returns the path it was written to; opens it for the
// person unless asked not to.
export async function renderDeck(spec: DeckSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; slides: number }> {
  const findings = auditDeck(spec.slides)
  if (findings.length) throw new Error(describeDeckFindings(findings))
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'WIDE', width: W, height: H })
  pptx.layout = 'WIDE'
  spec.slides.forEach((slide, index) => {
    if (index === 0 && !slide.bullets && !slide.table && !slide.chart) { titleSlide(pptx, spec); return }
    const s = contentFrame(pptx, slide, index + 1, spec.slides.length)
    const layout = deckBodyLayout(slide)
    if (slide.bullets && slide.bullets.length > 0) addBullets(s, slide.bullets, layout.top, layout.bulletsHeight)
    if (slide.table) addTable(pptx, s, slide.table, layout.tableTop, layout.rowHeights)
    if (slide.chart) addChart(pptx, s, slide.chart, layout.chartTop)
    if (slide.notes) s.addNotes(slide.notes)
  })
  const data = await pptx.write({ outputType: 'nodebuffer' }) as Buffer
  const path = await saveOfficeOutput(sanitize(spec.slides[0]?.title ?? spec.title ?? 'deck'), '.pptx', data, spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, slides: spec.slides.length }
}
