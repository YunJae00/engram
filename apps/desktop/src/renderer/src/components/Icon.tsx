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
