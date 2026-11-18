import { shell } from 'electron'
import { auditDeck, deckBodyLayout, describeDeckFindings, faceFor, withoutMissingParts, type OfficeTheme } from 'core'
import { officeOutputName, saveOfficeOutput } from './office-output.js'
import PptxGenJS from 'pptxgenjs'

interface DeckSeries { name: string; values: number[] }
interface DeckChart { type?: 'column' | 'line' | 'bar' | 'pie'; categories: string[]; series: DeckSeries[] }
interface DeckTable { rows: (string | number)[][] }
interface DeckSlide { title: string; subtitle?: string; bullets?: string[]; table?: DeckTable; chart?: DeckChart; notes?: string }
interface DeckSpec { slides: DeckSlide[]; saveAs?: string; title?: string; theme: OfficeTheme }

const W = 13.33
const H = 7.5
const MARGIN = 0.7
const COVER = 'ENGRAM_COVER', PAGE = 'ENGRAM_PAGE'

function sanitize(name: string): string {
  return (name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'deck')
}

function chartType(pptx: PptxGenJS, type: DeckChart['type']): PptxGenJS.CHART_NAME {
  if (type === 'line') return pptx.ChartType.line
  if (type === 'pie') return pptx.ChartType.pie
  return pptx.ChartType.bar
}

function titleSlide(pptx: PptxGenJS, spec: DeckSpec, t: OfficeTheme): void {
  const first = spec.slides[0]!
  const slide = pptx.addSlide({ masterName: COVER })
  slide.background = { color: t.colors.field }
  slide.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 3.5, w: 1.4, h: 0.09, fill: { color: t.colors.accent } })
  slide.addText(first.title, { placeholder: 'title', x: MARGIN, y: 1.4, w: W - MARGIN * 2, h: 1.9, fontFace: faceFor(first.title, t.fonts.title), fontSize: 40, color: t.colors.onField, bold: true, align: 'left', valign: 'bottom', fit: 'shrink' })
  if (first.subtitle) slide.addText(first.subtitle, { x: MARGIN, y: 3.8, w: W - MARGIN * 2, h: 2.0, fontFace: faceFor(first.subtitle, t.fonts.body), fontSize: 18, color: t.colors.onField, align: 'left', fit: 'shrink' })
  if (first.notes) slide.addNotes(first.notes)
}

function contentFrame(pptx: PptxGenJS, slide: DeckSlide, index: number, total: number, t: OfficeTheme): PptxGenJS.Slide {
  const s = pptx.addSlide({ masterName: PAGE })
  s.background = { color: t.colors.paper }
  s.addText(slide.title, { placeholder: 'title', x: MARGIN, y: 0.35, w: W - MARGIN * 2, h: 1.0, fontFace: faceFor(slide.title, t.fonts.title), fontSize: 26, color: t.colors.field, bold: true, fit: 'shrink', margin: 0 })
  s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.42, w: 1.1, h: 0.06, fill: { color: t.colors.accent } })
  if (slide.subtitle) s.addText(slide.subtitle, { x: MARGIN, y: 1.5, w: W - MARGIN * 2, h: deckBodyLayout(slide).subtitleHeight, fontFace: faceFor(slide.subtitle, t.fonts.body), fontSize: 14, color: t.colors.mute, italic: true, margin: 0 })
  s.addText(`${index} / ${total}`, { x: W - MARGIN - 1.2, y: H - 0.55, w: 1.2, h: 0.3, fontFace: t.fonts.body, fontSize: 9, color: t.colors.mute, align: 'right' })
  return s
}

function addBullets(slide: PptxGenJS.Slide, bullets: string[], top: number, height: number, t: OfficeTheme): void {
  slide.addText(
    bullets.map((text) => ({ text, options: { bullet: { code: '25AA', indent: 18 }, color: t.colors.ink, fontSize: 16, paraSpaceAfter: 10, breakLine: true } })),
    { x: MARGIN, y: top, w: W - MARGIN * 2, h: height, fontFace: faceFor(bullets.join(''), t.fonts.body), valign: 'top', margin: 0 },
  )
}

function addTable(pptx: PptxGenJS, slide: PptxGenJS.Slide, table: DeckTable, top: number, rowHeights: number[], t: OfficeTheme): void {
  const rows = table.rows.map((row, r) =>
    row.map((cell) => ({
      text: String(cell),
      options: {
        fontFace: faceFor(String(cell), t.fonts.body), fontSize: 13, color: r === 0 ? t.colors.onField : t.colors.ink, bold: r === 0,
        fill: { color: r === 0 ? t.colors.field : r % 2 === 0 ? t.colors.zebra : t.colors.paper },
        align: (r === 0 || typeof cell === 'number' ? 'center' : 'left') as PptxGenJS.HAlign,
        valign: 'middle' as PptxGenJS.VAlign, margin: 4,
      },
    })),
  )
  slide.addTable(rows, { x: MARGIN, y: top, w: W - MARGIN * 2, border: { type: 'solid', color: t.colors.hair, pt: 1 }, autoPage: false, rowH: rowHeights })
}

function addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, chart: DeckChart, top: number, t: OfficeTheme): void {
  const type = chartType(pptx, chart.type)
  const palette = t.colors.chart, face = faceFor([...chart.categories, ...chart.series.map(series => series.name)].join(''), t.fonts.body)
  if (chart.type === 'pie') {
    slide.addChart(type, [{ name: chart.series[0]!.name, labels: chart.categories, values: chart.series[0]!.values }], {
      x: MARGIN, y: top, w: W - MARGIN * 2, h: H - top - 0.7, showLegend: true, legendPos: 'r', chartColors: palette, showPercent: true, dataLabelColor: t.colors.onField, fontFace: face,
    })
    return
  }
  const data = chart.series.map((series) => ({ name: series.name, labels: chart.categories, values: series.values }))
  slide.addChart(type, data, {
    x: MARGIN, y: top, w: W - MARGIN * 2, h: H - top - 0.7,
    barDir: chart.type === 'bar' ? 'bar' : 'col',
    chartColors: palette, showLegend: chart.series.length > 1, legendPos: 'b', fontFace: face,
    catAxisLabelColor: t.colors.mute, valAxisLabelColor: t.colors.mute, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    showValue: false, valGridLine: { style: 'solid', color: t.colors.hair, size: 1 },
  })
}

export async function buildDeck(spec: DeckSpec): Promise<{ name: string; data: Buffer; slides: number }> {
  return { name: officeOutputName(spec.slides[0]?.title ?? spec.title ?? '', '.pptx', spec.saveAs, 'deck'), data: await composeDeck(spec), slides: spec.slides.length }
}

export async function renderDeck(spec: DeckSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; slides: number }> {
  const data = await composeDeck(spec)
  const path = await saveOfficeOutput(sanitize(spec.slides[0]?.title ?? spec.title ?? 'deck'), '.pptx', data, spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, slides: spec.slides.length }
}

async function composeDeck(spec: DeckSpec): Promise<Buffer> {
  const findings = auditDeck(spec.slides)
  if (findings.length) throw new Error(describeDeckFindings(findings))
  const t = spec.theme
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'WIDE', width: W, height: H })
  pptx.layout = 'WIDE'
  pptx.defineSlideMaster({ title: COVER, objects: [{ placeholder: { options: { name: 'title', type: 'title', x: MARGIN, y: 1.4, w: W - MARGIN * 2, h: 1.9 }, text: '' } }] })
  pptx.defineSlideMaster({ title: PAGE, objects: [{ placeholder: { options: { name: 'title', type: 'title', x: MARGIN, y: 0.35, w: W - MARGIN * 2, h: 1.0 }, text: '' } }] })
  spec.slides.forEach((slide, index) => {
    if (index === 0 && !slide.bullets && !slide.table && !slide.chart) { titleSlide(pptx, spec, t); return }
    const s = contentFrame(pptx, slide, index + 1, spec.slides.length, t)
    const layout = deckBodyLayout(slide)
    if (slide.bullets && slide.bullets.length > 0) addBullets(s, slide.bullets, layout.top, layout.bulletsHeight, t)
    if (slide.table) addTable(pptx, s, slide.table, layout.tableTop, layout.rowHeights, t)
    if (slide.chart) addChart(pptx, s, slide.chart, layout.chartTop, t)
    if (slide.notes) s.addNotes(slide.notes)
  })
  return withoutMissingParts(await pptx.write({ outputType: 'nodebuffer' }) as Buffer)
}
