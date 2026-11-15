import { useId } from 'react'
import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// Drawn on a 100-unit sphere after the approved orb sheet: a twisted sheet of light that pinches at the core (50, 50).
// Layer 1, left: a wide band (between the outer and the inner loop) sweeps up-left, folds over at the rim and returns under itself as a broad lobe.
// Layer 2, right: a teardrop band curls down to the lower right and a narrow streak runs out to the right rim.
// Layer 3: the faint ghost bubble offset to the upper right. Each band is a translucent sheet; only one edge of it is lit.
const OUTER = 'M48 49C42 41 34 33 24 30.5C15 28.5 7 34 4.5 44C2.5 55 7 67 18 74C28 80 44 81 54 77C59 74.5 60 68 57 62C55 58 51 53 48 49Z'
const INNER = 'M48 49C41 45 32 41 23 41C17 41 14.5 45 14.5 51C15 60 20 68 29 72C38 76 50 75 56 70C58.5 67 58 63 56 60C54 56 51 52 48 49Z'
const HOOK = 'M50 51C56 58 61 67 65 73C68 78 72 80 76 79C80 78 80.5 72 79 66C77 59 70 54 62 52C57 51 53 51 50 51Z'
const FOLD = 'M50 51C56 58 61 67 65 73C68 78 71 80 73 79.5C74.5 75 74.5 70 72.5 65C70 59 63 55 54 52Z'
const STREAK = 'M50 49C58 47 70 46.5 82 46C87 45.8 91 45 94.5 44C90 46.5 85 48.6 78 49.6C68 50.6 58 50.6 50 50.5Z'

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  const id = `${orb}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const url = (name: string) => `url(#${id}-${name})`
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <defs>
            <linearGradient id={`${id}-sheet`} gradientUnits="userSpaceOnUse" x1="28" y1="30" x2="36" y2="80">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.78" />
              <stop offset="0.36" className="bot-orb-tint" stopOpacity="0.3" />
              <stop offset="0.7" className="bot-orb-tint" stopOpacity="0.1" />
              <stop offset="1" className="bot-orb-tint" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id={`${id}-lobe`} gradientUnits="userSpaceOnUse" x1="36" y1="42" x2="30" y2="72">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.3" />
              <stop offset="0.6" className="bot-orb-tint" stopOpacity="0.1" />
              <stop offset="1" className="bot-orb-tint" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id={`${id}-under`} gradientUnits="userSpaceOnUse" x1="14" y1="48" x2="50" y2="74">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.55" />
              <stop offset="0.6" className="bot-orb-lit" stopOpacity="0.14" />
              <stop offset="1" className="bot-orb-lit" stopOpacity="0.04" />
            </linearGradient>
            <linearGradient id={`${id}-edge`} gradientUnits="userSpaceOnUse" x1="6" y1="40" x2="48" y2="49">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.6" />
              <stop offset="1" className="bot-orb-hot" stopOpacity="1" />
            </linearGradient>
          </defs>
          <path className="bot-orb-wash" d={INNER} fill={url('lobe')} />
          <path className="bot-orb-sheet" d={OUTER + INNER} fillRule="evenodd" fill={url('sheet')} />
          <path className="bot-orb-edge" d="M4.5 44C7 34 15 28.5 24 30.5C34 33 42 41 48 49M14.5 51C14.5 45 17 41 23 41C32 41 41 45 48 49" stroke={url('edge')} />
          <path className="bot-orb-edge bot-orb-edge-under" d="M14.5 51C15 60 20 68 29 72C38 76 50 75 56 70" stroke={url('under')} />
          <path className="bot-orb-edge bot-orb-edge-faint bot-orb-edge-soft" d="M4.5 44C2.5 55 7 67 18 74C28 80 44 81 54 77" />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <defs>
            <linearGradient id={`${id}-hook`} gradientUnits="userSpaceOnUse" x1="52" y1="52" x2="80" y2="78">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.5" />
              <stop offset="1" className="bot-orb-hot" stopOpacity="0.5" />
            </linearGradient>
            <linearGradient id={`${id}-streak`} gradientUnits="userSpaceOnUse" x1="50" y1="49" x2="90" y2="72">
              <stop offset="0" className="bot-orb-hot" stopOpacity="0.95" />
              <stop offset="1" className="bot-orb-lit" stopOpacity="0.6" />
            </linearGradient>
          </defs>
          <path className="bot-orb-sheet" d={HOOK + STREAK} fill={url('hook')} />
          <path className="bot-orb-sheet bot-orb-front" d={FOLD} fill={url('hook')} />
          <path className="bot-orb-edge" d="M50 51C56 58 61 67 65 73C68 78 72 80 76 79C80 78 80.5 72 79 66M52 48.6C60 47 72 46.4 82 46C87 45.8 91 45 94.5 44" stroke={url('streak')} />
          <path className="bot-orb-edge bot-orb-edge-faint" d="M54 52C63 55 70 59 72.5 65C74.5 70 74.5 75 73 79.5M79 66C77 59 70 54 62 52M54 50.4C66 50.6 80 49.2 92 45.2" />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <defs>
            <linearGradient id={`${id}-glass`} gradientUnits="userSpaceOnUse" x1="56" y1="17" x2="70" y2="75">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.26" />
              <stop offset="0.6" className="bot-orb-tint" stopOpacity="0.08" />
              <stop offset="1" className="bot-orb-tint" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`${id}-bubble`} gradientUnits="userSpaceOnUse" x1="42" y1="22" x2="88" y2="72">
              <stop offset="0" className="bot-orb-lit" stopOpacity="0.75" />
              <stop offset="0.55" className="bot-orb-tint" stopOpacity="0.24" />
              <stop offset="1" className="bot-orb-tint" stopOpacity="0.08" />
            </linearGradient>
          </defs>
          <circle className="bot-orb-bubble" cx="66" cy="46" r="29" fill={url('glass')} stroke={url('bubble')} />
        </svg>
      </span>
      <span className="bot-orb-core" />
    </span>
  )
}
