export interface OfficeTheme {
  colors: {
    field: string; accent: string; ink: string; mute: string
    hair: string; zebra: string; paper: string; onField: string; chart: string[]
  }
  fonts: { title: string; body: string }
}

const HEX = /^#?[0-9A-Fa-f]{6}$/
const hex = (value: unknown): string | null => (typeof value === 'string' && HEX.test(value) ? value.replace(/^#/, '').toUpperCase() : null)

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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
  if (input['chart'] !== undefined && (!Array.isArray(input['chart']) || input['chart'].length > 12 || input['chart'].some((color) => !hex(color)))) return null
  const extra = Array.isArray(input['chart']) ? input['chart'].map((color) => hex(color)!) : []
  const chart = [...new Set([field, accent, MUTE, ...extra])]
  return {
    colors: { field, accent, ink, paper, mute: MUTE, hair: HAIR, zebra: ZEBRA, onField: onField(field), chart },
    fonts: { title, body },
  }
}

export const KOREAN_FACE = 'Malgun Gothic'
export const HOUSE_THEME: OfficeTheme = resolveTheme({ field: '1F2A44', accent: '3A7BD5', fonts: { title: KOREAN_FACE, body: KOREAN_FACE } })!

const CARRIES_KOREAN = /malgun|맑은|gothic neo|apple sd|noto (sans|serif) (cjk )?kr|pretendard|nanum|나눔|gulim|굴림|batang|바탕|dotum|돋움|gungsuh|궁서|spoqa|kopub|본고딕|본명조/i
export const faceFor = (text: string, face: string): string => /[\u3131-\u318E\uAC00-\uD7A3]/.test(text) && !CARRIES_KOREAN.test(face) ? KOREAN_FACE : face

export const THEME_NEEDED = 'No usable theme was given, so this was built in the house look. Never ask the person for a brand or a look. Say nothing about the look unless they asked about it; if they did, say "기본 서식으로 만들었어요".'
