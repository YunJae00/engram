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

// A little star with a face: five pillowy limbs (nothing on it is sharp -
// even the smile's corners are round caps), leaning a few degrees so it
// reads as alive rather than stamped. Eyes and mouth are holes in the body
// (even-odd fill) so the surface underneath shows through, and the mark
// works on rows, tabs and bubbles alike. Below 20px the mouth goes and the
// eyes grow a touch, which is all those pixels can carry.
const STAR_BODY =
  'M13.80 2.37Q16.27 4.58 17.04 7.74Q20.17 8.62 22.29 11.15Q20.95 14.18 18.18 15.89Q18.31 19.14 16.55 21.94Q13.26 21.60 10.78 19.49Q7.73 20.62 4.53 19.82Q3.83 16.58 5.07 13.57Q3.05 11.02 2.83 7.72Q5.69 6.06 8.93 6.31Q10.74 3.60 13.80 2.37Z'
const STAR_EYES_SMALL =
  'M7.75 12.1a1.25 1.25 0 1 0 2.50 0a1.25 1.25 0 1 0 -2.50 0ZM13.75 12.1a1.25 1.25 0 1 0 2.50 0a1.25 1.25 0 1 0 -2.50 0Z'
const STAR_EYES =
  'M8.05 12.1a0.95 0.95 0 1 0 1.90 0a0.95 0.95 0 1 0 -1.90 0ZM14.05 12.1a0.95 0.95 0 1 0 1.90 0a0.95 0.95 0 1 0 -1.90 0Z'
const STAR_SMILE =
  'M13.48 13.68A2.55 2.55 0 0 1 10.52 13.68A0.45 0.45 0 0 1 11.04 12.94A1.65 1.65 0 0 0 12.96 12.94A0.45 0.45 0 0 1 13.48 13.68Z'
const FACE_DETAIL_MIN = 20

export function Comet({ size = 15 }: { size?: number }) {
  const detailed = size >= FACE_DETAIL_MIN
  const d = STAR_BODY + (detailed ? STAR_EYES + STAR_SMILE : STAR_EYES_SMALL)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} fillRule="evenodd" />
    </svg>
  )
}

// The app wears the same little star the comets do: one face for the whole
// product, in the corner and on the rail alike.
export function Logomark({ size = 20 }: { size?: number }) {
  return (
    <span className="logomark" aria-hidden>
      <Comet size={size} />
    </span>
  )
}
