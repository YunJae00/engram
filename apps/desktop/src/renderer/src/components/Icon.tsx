import {
  MessageCircle,
  Minus,
  Plus,
  Search,
  Settings,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Icon set: Lucide (consistent 24-grid line icons) at a calm 1.8 stroke.
const ICONS: Record<string, LucideIcon> = {
  zap: Zap,
  chat: MessageCircle,
  search: Search,
  settings: Settings,
  plus: Plus,
  minus: Minus,
}

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  const Component = ICONS[name]
  if (!Component) return null
  return <Component size={size} strokeWidth={1.8} aria-hidden />
}

export function OrbitMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" data-icon="orbit" aria-hidden>
      <ellipse cx="12" cy="12" rx="10" ry="6.3" transform="rotate(-35 12 12)" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="20.2" cy="6.3" r="2" fill="currentColor" stroke="none" />
      <circle cx="3.8" cy="17.7" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

// The comet: a five-point star leaning into flight, its tips rounded by a
// thick round-joined stroke in the same colour, and three fading dots trailing
// down-left. Nothing on it is sharp. Same numbers as the app icon
// (scripts/gen-icon.mjs) and the tray glyph (tray.ts), in a 24 grid. Below
// 20px the third dot is sub-pixel, so only two trail.
const STAR = { cx: 13.9, cy: 10.1, R: 5.25, r: 3.2, sw: 2.25, tilt: 12 }
const STAR_PATH = `M${Array.from({ length: 10 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 5
  const rad = k % 2 === 0 ? STAR.R : STAR.r
  return `${(STAR.cx + rad * Math.cos(a)).toFixed(2)} ${(STAR.cy + rad * Math.sin(a)).toFixed(2)}`
}).join('L')}Z`
const TRAIL = [
  [8.6, 15.4, 1.6],
  [5.8, 18.0, 1.15],
  [3.75, 20.05, 0.75],
] as const
const TRAIL_DETAIL_MIN = 20

export function Comet({ size = 15 }: { size?: number }) {
  const dots = size >= TRAIL_DETAIL_MIN ? 3 : 2
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={STAR_PATH} transform={`rotate(${STAR.tilt} ${STAR.cx} ${STAR.cy})`} stroke="currentColor" strokeWidth={STAR.sw} strokeLinejoin="round" />
      {TRAIL.slice(0, dots).map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}
    </svg>
  )
}

const FACE_BODY =
  'M13.80 2.37Q16.27 4.58 17.04 7.74Q20.17 8.62 22.29 11.15Q20.95 14.18 18.18 15.89Q18.31 19.14 16.55 21.94Q13.26 21.60 10.78 19.49Q7.73 20.62 4.53 19.82Q3.83 16.58 5.07 13.57Q3.05 11.02 2.83 7.72Q5.69 6.06 8.93 6.31Q10.74 3.60 13.80 2.37Z'
const FACE_EYES_SMALL =
  'M7.75 12.1a1.25 1.25 0 1 0 2.50 0a1.25 1.25 0 1 0 -2.50 0ZM13.75 12.1a1.25 1.25 0 1 0 2.50 0a1.25 1.25 0 1 0 -2.50 0Z'
const FACE_EYES =
  'M8.05 12.1a0.95 0.95 0 1 0 1.90 0a0.95 0.95 0 1 0 -1.90 0ZM14.05 12.1a0.95 0.95 0 1 0 1.90 0a0.95 0.95 0 1 0 -1.90 0Z'
const FACE_SMILE =
  'M13.48 13.68A2.55 2.55 0 0 1 10.52 13.68A0.45 0.45 0 0 1 11.04 12.94A1.65 1.65 0 0 0 12.96 12.94A0.45 0.45 0 0 1 13.48 13.68Z'

export function CometFace({ size = 15 }: { size?: number }) {
  const d = FACE_BODY + (size >= 20 ? FACE_EYES + FACE_SMILE : FACE_EYES_SMALL)
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" data-icon="comet-face" aria-hidden><path d={d} fillRule="evenodd" /></svg>
}
