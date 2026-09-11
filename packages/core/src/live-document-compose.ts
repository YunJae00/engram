import type { AgentTool, AgentToolContext } from './agent-loop.js'
import { carriesSecret, secretsIn } from './secrets.js'

const text = { type: 'string', maxLength: 8000 }
const color = { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' }
const style = { fontSize: { type: 'number', minimum: 8, maximum: 120 }, color, bold: { type: 'boolean' } }
const box = { type: 'object', additionalProperties: false, required: ['text', 'x', 'y', 'width', 'height', 'fontSize', 'color'], properties: {
  text, ...style, fill: color, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
} }

export function liveDocumentCompose(run: (args: Record<string, unknown>, context: AgentToolContext) => Promise<string>): AgentTool {
  return {
    name: 'compose_live_document',
    description: 'Compose content in the SAME open Windows Office document after read_live_document. Choose exactly one payload: slides (PowerPoint, up to 12 slides of positioned text boxes; optional slide targets an existing slide, otherwise append a blank slide), paragraphs (Word, append styled paragraphs), or format (Excel, style ONLY the range of the preceding read). Positions and sizes are points within pageWidth/pageHeight returned by the read. Each slide supports background and up to 40 text boxes, with optional solid fills. Prefer small coherent batches that produce visible progress within the observation lifetime; re-read between batches. No fixed template: plan content and geometry yourself. This adds content; it never deletes existing slides, shapes or text, saves/closes, runs code, or edits the backing file. Use edit_live_document for existing text/cells. Requires a fresh snapshot and unchanged observed content. Batches may partially apply: inspect completed/error and re-read; NEVER blindly replay. Layout must be visually verified independently. Unsupported apps and richer operations use desktop tools. Esc/Stop and user restrictions apply.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['snapshot'], properties: {
      snapshot: { type: 'string', pattern: '^[a-f0-9]{32}$' },
      slides: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['boxes'], properties: { slide: { type: 'integer', minimum: 1, maximum: 10000 }, background: color, boxes: { type: 'array', minItems: 1, maxItems: 40, items: box } } } },
      paragraphs: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text, ...style } } },
      format: { type: 'object', additionalProperties: false, properties: { ...style, numberFormat: { type: 'string', enum: ['General', '#,##0', '#,##0.00', '0%', '0.00%'] }, autoFit: { type: 'boolean' } } },
    } },
    async run(args, context) {
      context.signal?.throwIfAborted()
      validateComposition(args)
      const contents = JSON.stringify(args)
      if (secretsIn(contents).length || carriesSecret(contents, context.task) || carriesSecret(contents, context.read ?? '')) throw new Error('Enter secrets directly, not through document composition.')
      return run(args, context)
    },
  }
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unsupported composition field.')
  return value as Record<string, unknown>
}
function items(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error('Invalid composition batch size.')
  return value
}
function validateStyle(value: Record<string, unknown>): void {
  if ('fontSize' in value && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize < 8 || value.fontSize > 120)) throw new Error('Font size must be 8 to 120 points.')
  for (const key of ['color', 'fill', 'background']) if (key in value && (typeof value[key] !== 'string' || !/^#?[0-9a-f]{6}$/i.test(value[key]))) throw new Error('Use a six-digit RGB color, with an optional # prefix.')
  for (const key of ['bold', 'autoFit']) if (key in value && typeof value[key] !== 'boolean') throw new Error('Expected a boolean style flag.')
  if ('text' in value && (typeof value.text !== 'string' || value.text.length > 8000 || [...value.text].some(char => char.charCodeAt(0) < 32 && !'\t\n'.includes(char)))) throw new Error('Invalid composition text.')
}
export function validateComposition(args: Record<string, unknown>): void {
  record(args, ['snapshot', 'slides', 'paragraphs', 'format'])
  if (typeof args.snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(args.snapshot) || JSON.stringify(args).length > 48000) throw new Error('Use a fresh snapshot and at most 48 KB.')
  if (['slides', 'paragraphs', 'format'].filter(key => key in args).length !== 1) throw new Error('Choose exactly one composition payload.')
  if ('slides' in args) for (const raw of items(args.slides, 12)) {
    const slide = record(raw, ['slide', 'background', 'boxes'])
    if ('slide' in slide && (!Number.isInteger(slide.slide) || Number(slide.slide) < 1 || Number(slide.slide) > 10000)) throw new Error('Invalid existing slide index.')
    validateStyle(slide)
    for (const rawBox of items(slide.boxes, 40)) {
      const item = record(rawBox, ['text', 'x', 'y', 'width', 'height', 'fontSize', 'color', 'bold', 'fill'])
      if (!['text', 'fontSize', 'color'].every(key => key in item)) throw new Error('Each box needs text and font styling.')
      validateStyle(item)
      for (const key of ['x', 'y', 'width', 'height']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 4000 || (['width', 'height'].includes(key) && item[key] === 0)) throw new Error('Invalid box geometry.')
    }
  }
  if ('paragraphs' in args) for (const raw of items(args.paragraphs, 80)) {
    const item = record(raw, ['text', 'fontSize', 'color', 'bold'])
    if (!('text' in item)) throw new Error('Paragraph text is required.')
    validateStyle(item)
  }
  if ('format' in args) {
    const item = record(args.format, ['fontSize', 'color', 'bold', 'numberFormat', 'autoFit'])
    if (!Object.keys(item).length) throw new Error('Supply at least one format property.')
    validateStyle(item)
    if ('numberFormat' in item && !['General', '#,##0', '#,##0.00', '0%', '0.00%'].includes(String(item.numberFormat))) throw new Error('Unsupported number format.')
  }
}
