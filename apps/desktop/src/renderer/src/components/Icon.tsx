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

// A comet with a face: the helpers that sweep between the memory-stars and
// come back carrying things. Drawn on the same 1.8-stroke grid as the Lucide
// set around it; the two dot-eyes are what make it a colleague, not a rock.
export function Comet({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="15.4" cy="8.6" r="3.8" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="14.2" cy="8.3" r="0.95" fill="currentColor" />
      <circle cx="17" cy="8.3" r="0.95" fill="currentColor" />
      <path d="M11.6 11.9 Q8.6 15.4 4.6 17.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M13.4 13.9 Q11.6 17 8.9 19.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75" />
      <path d="M10.8 9.4 Q7.4 10.4 4.9 12.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.55" />
    </svg>
  )
}
