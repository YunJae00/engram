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

const STARLIGHT = 'currentColor'

export function Logomark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="logomark">
      <path
        d="M6.4 12.6 L3.7 4.9 M6.4 12.6 L11.3 9.5 M11.3 9.5 L15.1 5.3 M15.1 5.3 L16.6 14.9"
        stroke={STARLIGHT}
        strokeOpacity="0.7"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Brightness carries meaning on the sky, but at 13-26px it just reads as
          a smudge — the mark keeps the ranking and lifts the floor. */}
      <circle cx="6.4" cy="12.6" r="2.9" fill={STARLIGHT} />
      <circle cx="15.1" cy="5.3" r="2.3" fill={STARLIGHT} />
      <circle cx="3.7" cy="4.9" r="1.6" fill={STARLIGHT} opacity="0.95" />
      <circle cx="16.6" cy="14.9" r="1.45" fill={STARLIGHT} opacity="0.85" />
      <circle cx="11.3" cy="9.5" r="1.2" fill={STARLIGHT} opacity="0.7" />
    </svg>
  )
}

// Faces only earn their pixels above this size; below it the comet is a bright
// head with a tail, which is all a 14px row can show anyway.
const FACE_DETAIL_MIN = 20

// A small friendly comet: big round head, two wide-set eyes, one plump tapered
// tail and a faint second streak. Eyes and smile are holes in the head
// (even-odd fill) so the surface underneath shows through — no guessed
// background token, so it sits on rows, tabs and bubbles alike.
export function Comet({ size = 15 }: { size?: number }) {
  const detailed = size >= FACE_DETAIL_MIN
  const head =
    // A head that fills the box, eyes set wide and a touch below centre - the
    // proportions that read as a face rather than a skull at 14px.
    'M8.3 14.6a6.7 6.7 0 1 0 13.4 0a6.7 6.7 0 1 0-13.4 0Z' +
    'M11.2 14a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0Z' +
    'M16.2 14a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0Z' +
    (detailed ? 'M13.3 16.9Q15 18.6 16.7 16.9Q15 20.4 13.3 16.9Z' : '')
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M10.2 10.6Q5.2 8.6 2.6 2.6Q8.4 4.8 12.4 8.6Z" opacity="0.55" />
      <path d="M8.4 17.4 5.6 15.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
      <path d={head} fillRule="evenodd" />
      {detailed && (
        <path d="M20.6 3 21.2 4.6 22.8 5.2 21.2 5.8 20.6 7.4 20 5.8 18.4 5.2 20 4.6Z" opacity="0.7" />
      )}
    </svg>
  )
}
