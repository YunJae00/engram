// Design is data the caller supplies, not a look baked here. The model passes
// the brand - a main colour, an accent, and the fonts - and this expands it
// into the full set a renderer needs, filling only the structural neutrals
// (white paper, near-black ink, grey rules) that carry no brand. When the
// model passes nothing, the caller asks the person; it never invents a brand.

export interface OfficeTheme {
  colors: {
    field: string; accent: string; ink: string; mute: string
    hair: string; zebra: string; paper: string; onField: string; chart: string[]
  }
  fonts: { title: string; body: string }
}

// What the model sends: two brand colours and the fonts. Everything else is
// structural and filled in, so the model never dictates greys or white. When a
// chart needs more than the two brand colours to keep series apart, the model
// passes the extra hues in chart; otherwise the palette stays on what it gave.
export interface ThemeInput { field: string; accent: string; fonts: { title: string; body: string }; ink?: string; paper?: string; chart?: string[] }

const HEX = /^#?[0-9A-Fa-f]{6}$/
const hex = (value: unknown): string | null => (typeof value === 'string' && HEX.test(value) ? value.replace(/^#/, '').toUpperCase() : null)

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// The neutral structure every document shares - not brand, the way page
// margins are not brand: white ground, dark text, quiet greys.
const INK = '1F2430'
const PAPER = 'FFFFFF'
const MUTE = '6B7280'
const HAIR = 'D8DCE4'
const ZEBRA = 'F4F6FA'
function onField(color: string): string {
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  return luminance > 0.179 ? '000000' : 'FFFFFF'
}

// Expands the brand the model gave into a full theme, or null if what it gave
// is not a usable brand (so the caller can ask again).
export function resolveTheme(input: unknown): OfficeTheme | null {
  if (!plain(input) || !plain(input['fonts'])) return null
  if (Object.keys(input).some((key) => !['field', 'accent', 'fonts', 'ink', 'paper', 'chart'].includes(key))) return null
  const field = hex(input['field'])
  const accent = hex(input['accent'])
  const fonts = input['fonts'] as Record<string, unknown>
  if (Object.keys(fonts).some((key) => !['title', 'body'].includes(key))) return null
  const title = typeof fonts['title'] === 'string' && fonts['title'].trim() && fonts['title'].length <= 60 ? fonts['title'].trim() : null
  const body = typeof fonts['body'] === 'string' && fonts['body'].trim() && fonts['body'].length <= 60 ? fonts['body'].trim() : null
  if (!field || !accent || !title || !body) return null
  if ([...title, ...body].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null
  if (['ink', 'paper'].some((key) => input[key] !== undefined && !hex(input[key]))) return null
  const ink = hex(input['ink']) ?? INK
  const paper = hex(input['paper']) ?? PAPER
  // The chart palette is the brand's own colours; extra hues for many-series
  // charts come from the model, never invented here.
  if (input['chart'] !== undefined && (!Array.isArray(input['chart']) || input['chart'].length > 12 || input['chart'].some((color) => !hex(color)))) return null
  const extra = Array.isArray(input['chart']) ? input['chart'].map((color) => hex(color)!) : []
  const chart = [...new Set([field, accent, MUTE, ...extra])]
  return {
    colors: { field, accent, ink, paper, mute: MUTE, hair: HAIR, zebra: ZEBRA, onField: onField(field), chart },
    fonts: { title, body },
  }
}

// The message a tool returns when no theme was passed: the model carries this
// to the person instead of choosing a look on its own.
export const THEME_NEEDED = 'This needs a look to render, and none was given. Ask the person for the brand to use - a main colour, an accent colour, and heading/body fonts - then pass them as theme: {field, accent, fonts:{title, body}}. If they say to just pick something, choose a tasteful set yourself and pass it.'
