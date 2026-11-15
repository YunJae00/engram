import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// Drawn on a 100-unit sphere after the approved orb sheet: a twisted sheet of light that pinches at the core (50, 50).
// Layer 1, left: a wide band sweeps up-left from the core, folds over near the rim and returns under itself as a broad lobe;
// the outer and inner loops are two overlapping translucent sheets, the lit top band is where the fold faces the viewer.
// Layer 2, right: a teardrop band curls down to the lower right and a narrow streak runs out to the right rim.
// Layer 3: the faint ghost bubble offset to the upper right.
// Bands are translucent filled sheets that brighten where they overlap, with one lit edge; bot-orb.css fades every layer with a mask, so no gradient ids are needed.
const OUTER = 'M48 49C42 41 34 33 24 30.5C15 28.5 7 34 4.5 44C2.5 55 7 67 18 74C28 80 44 81 54 77C59 74.5 60 68 57 62C55 58 51 53 48 49Z'
const INNER = 'M48 49C41 45 32 41 23 41C17 41 14.5 45 14.5 51C15 60 20 68 29 72C38 76 50 75 56 70C58.5 67 58 63 56 60C54 56 51 52 48 49Z'
const TOP = 'M48 49C42 41 34 33 24 30.5C15 28.5 7 34 4.5 44C7 47.5 10.5 50 14.5 51C14.5 45 17 41 23 41C32 41 41 45 48 49Z'
const HOOK = 'M50 51C56 58 61 67 65 73C68 78 72 80 76 79C80 78 80.5 72 79 66C77 59 70 54 62 52C57 51 53 51 50 51Z'
const FOLD = 'M50 51C56 58 61 67 65 73C68 78 71 80 73 79.5C74.5 75 74.5 70 72.5 65C70 59 63 55 54 52Z'
const STREAK = 'M50 49C58 47 70 46.5 82 45.6C87 45.2 91 44 94.5 42.2C90 46 85 48.6 78 50C68 51.4 58 51.2 50 50.5Z'

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <path className="bot-orb-wash" d={OUTER} />
          <path className="bot-orb-wash" d={INNER} />
          <path className="bot-orb-sheet" d={TOP} />
          <path className="bot-orb-edge" d="M4.5 44C7 34 15 28.5 24 30.5C34 33 42 41 48 49M14.5 51C14.5 45 17 41 23 41C32 41 41 45 48 49" />
          <path className="bot-orb-edge bot-orb-edge-under" d="M14.5 51C15 60 20 68 29 72C38 76 50 75 56 70" />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <path className="bot-orb-sheet" d={HOOK} />
          <path className="bot-orb-sheet bot-orb-front" d={FOLD} />
          <path className="bot-orb-sheet bot-orb-thin" d={STREAK} />
          <path className="bot-orb-edge" d="M50 51C56 58 61 67 65 73C68 78 72 80 76 79C80 78 80.5 72 79 66M52 48.6C60 47 72 46.4 82 45.6C87 45.2 91 44 94.5 42.2" />
          <path className="bot-orb-edge bot-orb-edge-faint" d="M54 52C63 55 70 59 72.5 65C74.5 70 74.5 75 73 79.5M79 66C77 59 70 54 62 52M54 50.8C66 51.2 80 49.6 92 44.6" />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false">
          <circle className="bot-orb-bubble" cx="66" cy="46" r="29" />
        </svg>
      </span>
      <span className="bot-orb-core" />
    </span>
  )
}
