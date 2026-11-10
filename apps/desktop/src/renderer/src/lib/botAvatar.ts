export const AVATAR_RANGES = { body: 5, face: 5, accessory: 8, palette: 7 } as const

type Part = keyof typeof AVATAR_RANGES
const PARTS = ['body', 'face', 'accessory', 'palette'] as const satisfies readonly Part[]

export type DrawnSpec = { kind: 'drawn'; body: number | 'sun'; face: number; accessory: number; palette: number | 'sun' }
export type ImageSpec = { kind: 'image'; image: string }
export type AvatarSpec = DrawnSpec | ImageSpec

export type Tone = { fill: string; line: string }
export type Palette = { light: Tone; dark: Tone; ink: string }

const tone = (fill: string, line: string): Tone => ({ fill, line })

export const PALETTES: readonly Palette[] = [
  { light: tone('#FF8A7A', '#D9584A'), dark: tone('#E8705F', '#FFB3A8'), ink: '#3A1712' },
  { light: tone('#FFB04D', '#C9741A'), dark: tone('#E8953A', '#FFD09A'), ink: '#3B2208' },
  { light: tone('#FFD84D', '#A88410'), dark: tone('#E0BC33', '#FFE88F'), ink: '#3A3005' },
  { light: tone('#5ED6B0', '#22876A'), dark: tone('#3FBF98', '#9AEBD2'), ink: '#0C3328' },
  { light: tone('#6EC1FF', '#2A7FC2'), dark: tone('#4FA8EE', '#A9DBFF'), ink: '#0B2C45' },
  { light: tone('#B49CFF', '#6E52D6'), dark: tone('#9A80F0', '#D2C5FF'), ink: '#24164F' },
  { light: tone('#FF9CCB', '#C9528C'), dark: tone('#EC7FB3', '#FFC6E1'), ink: '#45122D' },
  { light: tone('#A9B4C2', '#5E6A7A'), dark: tone('#8C98A8', '#CDD5DF'), ink: '#1C232C' },
]

export const SUN_PALETTE: Palette = { light: tone('#FFC233', '#C77A00'), dark: tone('#F0AE1A', '#FFDB80'), ink: '#3B2208' }

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

const hexChannels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

export function blush(fill: string, coral: string): string {
  const c = hexChannels(coral)
  return '#' + hexChannels(fill).map((v, i) => Math.round(0.6 * v + 0.4 * c[i]!).toString(16).padStart(2, '0')).join('')
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
  planetShade: 'M18 52a30 30 0 0 0 60 0a30 13 0 0 1 -60 0Z',
  ringFront: 'M4 52a44 10 0 0 0 88 0',
  cometTails: 'M66 30L84 12M74 42L90 30M56 24L64 8',
  star: 'M44.1 19.3Q48 13 51.9 19.3L62.1 35.6L80.7 40.2Q87.9 42 83.2 47.7L70.8 62.4L72.2 81.5Q72.7 89 65.8 86.2L48 79L30.2 86.2Q23.3 89 23.8 81.5L25.2 62.4L12.8 47.7Q8.1 42 15.3 40.2L33.9 35.6Z',
  nebula: 'M12 58a20 20 0 1 0 40 0a20 20 0 1 0 -40 0ZM44 58a20 20 0 1 0 40 0a20 20 0 1 0 -40 0ZM26 40a22 22 0 1 0 44 0a22 22 0 1 0 -44 0Z',
  sunRays: 'M84 52L90 52M73.5 77.5L77.7 81.7M48 88L48 94M22.5 77.5L18.3 81.7M12 52L6 52M22.5 26.5L18.3 22.3M48 16L48 10M73.5 26.5L77.7 22.3',
  smile: 'M42 60q6 6 12 0',
  grin: 'M40 59q8 9 16 0',
  happyLeft: 'M32 53l6-6l6 6',
  happyRight: 'M52 53l6-6l6 6',
  winkRight: 'M52 51q6-6 12 0',
  dashLeft: 'M32 50h12',
  dashRight: 'M52 50h12',
  calmLeft: 'M32 48q6 6 12 0',
  calmRight: 'M52 48q6 6 12 0',
  headsetBand: 'M20 48a28 28 0 0 1 56 0',
  headsetMic: 'M80 58q0 14-14 16',
  glasses: 'M29 50a9 9 0 1 0 18 0a9 9 0 1 0 -18 0ZM49 50a9 9 0 1 0 18 0a9 9 0 1 0 -18 0ZM47 50h2',
  pencil: 'M62 88l20-20l7 7l-20 20Z',
  pencilTip: 'M62 88l-3 9l10-2Z',
  magnifierHandle: 'M78 80l9 9',
  calendarRings: 'M68 62v7M80 62v7',
  bookPages: 'M72 70v20',
  cup: 'M62 70h18v12a6 6 0 0 1-6 6h-6a6 6 0 0 1-6-6Z',
  cupHandle: 'M80 73h3a4 4 0 0 1 0 8h-3',
  steam: 'M68 66q-3-3 0-7M75 66q-3-3 0-7',
  envelopeFlap: 'M60 70l13 9l13-9',
} as const

export const CRATERS = [[64, 36, 4], [72, 60, 3], [30, 38, 3]] as const
