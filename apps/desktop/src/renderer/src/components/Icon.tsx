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

// The errand's face. Deliberately not a robot: a small round helper with an
// antenna, drawn on the same 1.8-stroke grid as the Lucide set around it.
export function ErrandFace({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* antenna with a little bobble */}
      <line x1="12" y1="7.4" x2="12" y2="5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="3.9" r="1.2" fill="currentColor" />
      {/* soft round head */}
      <rect x="4.6" y="7.4" width="14.8" height="12.2" rx="6.1" stroke="currentColor" strokeWidth="1.8" />
      {/* eyes */}
      <circle cx="9.3" cy="12.6" r="1.25" fill="currentColor" />
      <circle cx="14.7" cy="12.6" r="1.25" fill="currentColor" />
      {/* smile */}
      <path d="M9.6 15.4 Q12 17.2 14.4 15.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}
