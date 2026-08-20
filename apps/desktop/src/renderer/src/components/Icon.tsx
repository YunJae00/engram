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

// A comet with a face. Big round head, two wide eyes, a soft smile and a
// short double tail — cute at 14px, still legible at 30px. Filled head so the
// eyes read as eyes instead of two stray dots on a ring.
export function Comet({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.8 7.2 Q6.2 8.4 3.6 10.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path
        d="M10.4 15.6 Q7 17.2 4.4 19.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path d="M9.6 11.4 Q5.6 12.6 2.6 15" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" opacity="0.7" />
      <circle cx="15.2" cy="11.4" r="5.6" fill="currentColor" />
      <circle cx="13.3" cy="10.3" r="1.15" fill="var(--panel-bg, #fff)" />
      <circle cx="17.1" cy="10.3" r="1.15" fill="var(--panel-bg, #fff)" />
      <path
        d="M13.4 13.5 Q15.2 15 17 13.5"
        stroke="var(--panel-bg, #fff)"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
