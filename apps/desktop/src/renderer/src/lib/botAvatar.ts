export const AVATAR_RANGES = { body: 5, face: 5, accessory: 8, palette: 7 } as const

type Part = keyof typeof AVATAR_RANGES
const PARTS = ['body', 'face', 'accessory', 'palette'] as const satisfies readonly Part[]

export type DrawnSpec = { kind: 'drawn'; body: number | 'sun'; face: number; accessory: number; palette: number | 'sun' }
export type ImageSpec = { kind: 'image'; image: string }
export type AvatarSpec = DrawnSpec | ImageSpec

export type Tone = { fill: string }
export type Palette = { light: Tone; dark: Tone }

const tone = (light: string, dark: string): Palette => ({ light: { fill: light }, dark: { fill: dark } })

export const PALETTES: readonly Palette[] = [
  tone('#2F6FEB', '#4C86F0'),
  tone('#D63F8C', '#E25A9C'),
  tone('#0A86B8', '#1197CC'),
  tone('#E2560E', '#EC6A2A'),
  tone('#7A4FE0', '#9068EC'),
  tone('#0F8F80', '#1EA393'),
  tone('#2E8F3E', '#3DA34E'),
  tone('#56607A', '#7A859C'),
]

export const SUN_PALETTE: Palette = tone('#D46A00', '#E07A0A')

export function paletteOf(palette: number | 'sun'): Palette {
  return palette === 'sun' ? SUN_PALETTE : PALETTES[palette]!
}

export function fnv1a(id: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(id)) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

type Parts = Record<Part, number>

// Each property is read once and copied, so a getter cannot change a value after it was validated.
function readOverride(value: unknown): Parts | { image: string } | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const keys = Reflect.ownKeys(value)
    const record = value as Record<string, unknown>
    if (keys.length === 1 && keys[0] === 'image') {
      const image = record.image
      return typeof image === 'string' ? { image } : null
    }
    if (keys.length !== PARTS.length || !PARTS.every(part => keys.includes(part))) return null
    const parts = { body: 0, face: 0, accessory: 0, palette: 0 }
    for (const part of PARTS) {
      const n = record[part]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > AVATAR_RANGES[part]) return null
      parts[part] = n
    }
    return parts
  } catch {
    return null
  }
}

export function avatarSpec(id: string, override?: unknown, primary = false): AvatarSpec {
  const valid = readOverride(override)
  if (valid && 'image' in valid) return { kind: 'image', image: valid.image }
  const h = fnv1a(id)
  const parts = valid ?? { body: h % 6, face: (h >>> 8) % 6, accessory: 0, palette: (h >>> 16) % 8 }
  return {
    kind: 'drawn',
    body: primary ? 'sun' : parts.body,
    face: parts.face,
    accessory: parts.accessory,
    palette: primary && !valid ? 'sun' : parts.palette,
  }
}

export const PATHS = {
  sunRays: 'M73.5 42.8L86.8 44.1Q91.5 48 86.8 51.9L73.5 53.2ZM69.7 62.4L78.2 72.7Q78.8 78.8 72.7 78.2L62.4 69.7ZM53.2 73.5L51.9 86.8Q48 91.5 44.1 86.8L42.8 73.5ZM33.6 69.7L23.3 78.2Q17.2 78.8 17.8 72.7L26.3 62.4ZM22.5 53.2L9.2 51.9Q4.5 48 9.2 44.1L22.5 42.8ZM26.3 33.6L17.8 23.3Q17.2 17.2 23.3 17.8L33.6 26.3ZM42.8 22.5L44.1 9.2Q48 4.5 51.9 9.2L53.2 22.5ZM62.4 26.3L72.7 17.8Q78.8 17.2 78.2 23.3L69.7 33.6Z',
  ring: 'M4 50a44 16 0 1 0 88 0a44 16 0 1 0 -88 0ZM14 50a34 8 0 1 0 68 0a34 8 0 1 0 -68 0Z',
  comet: 'M14 14L66.8 31.4A28 28 0 1 1 31.4 66.8Z',
  moon: 'M33 16.3A36 36 0 1 1 16 59.9A26 26 0 0 0 33 16.3Z',
  star: 'M43.2 12.8Q48 4 52.8 12.8L59.3 24.6Q62.7 30.8 69.6 32.1L82.9 34.6Q92.7 36.5 85.8 43.8L76.6 53.6Q71.8 58.7 72.7 65.7L74.4 79.1Q75.6 89 66.6 84.8L54.3 79Q48 76 41.7 79L29.4 84.8Q20.4 89 21.6 79.1L23.3 65.7Q24.2 58.7 19.4 53.6L10.2 43.8Q3.3 36.5 13.1 34.6L26.4 32.1Q33.3 30.8 36.7 24.6Z',
} as const
