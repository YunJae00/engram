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
const ON_FIELD = 'FFFFFF'

// Expands the brand the model gave into a full theme, or null if what it gave
// is not a usable brand (so the caller can ask again).
export function resolveTheme(input: unknown): OfficeTheme | null {
  if (!plain(input) || !plain(input['fonts'])) return null
  const field = hex(input['field'])
  const accent = hex(input['accent'])
  const fonts = input['fonts'] as Record<string, unknown>
  const title = typeof fonts['title'] === 'string' && fonts['title'].trim() && fonts['title'].length <= 60 ? fonts['title'].trim() : null
  const body = typeof fonts['body'] === 'string' && fonts['body'].trim() && fonts['body'].length <= 60 ? fonts['body'].trim() : null
  if (!field || !accent || !title || !body) return null
  const ink = hex(input['ink']) ?? INK
  const paper = hex(input['paper']) ?? PAPER
  // The chart palette is the brand's own colours; extra hues for many-series
  // charts come from the model, never invented here. Bad entries are dropped.
  const extra = Array.isArray(input['chart']) ? input['chart'].map(hex).filter((c): c is string => Boolean(c)) : []
  const chart = [...new Set([field, accent, MUTE, ...extra])]
  return {
    colors: { field, accent, ink, paper, mute: MUTE, hair: HAIR, zebra: ZEBRA, onField: ON_FIELD, chart },
    fonts: { title, body },
  }
}

// The message a tool returns when no theme was passed: the model carries this
// to the person instead of choosing a look on its own.
export const THEME_NEEDED = 'This needs a look to render, and none was given. Ask the person for the brand to use - a main colour, an accent colour, and heading/body fonts - then pass them as theme: {field, accent, fonts:{title, body}}. If they say to just pick something, choose a tasteful set yourself and pass it.'
