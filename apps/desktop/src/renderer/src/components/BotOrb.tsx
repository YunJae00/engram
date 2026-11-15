import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// Drawn on a 100-unit sphere; the ribbons cross at the core (52, 53), like the approved orb sheet.
// 1: the two left lobes of the twist. 2: the hook and the streak to the right. 3: the ghost inner bubble.
const LAYERS = [
  'M52 53C44 44 28 33 16 34C8 35 6 44 9 50C12 56 20 53 30 51C40 49 47 51 52 53ZM52 53C42 46 28 42 21 44C15 46 16 58 20 68C25 79 40 80 50 74C56 70 55 60 52 53Z',
  'M52 53C60 57 67 65 70 73C72 79 77 79 78 73C79 66 75 58 67 55C61 53 56 53 52 53ZM52 53C62 49 78 44 92 45C82 50 66 54 52 53Z',
  'M36 49A28 28 0 1 0 92 49A28 28 0 1 0 36 49Z',
]

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        {LAYERS.map(d => <svg key={d} className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false"><path d={d} fillRule="evenodd" /></svg>)}
      </span>
      <span className="bot-orb-core" />
    </span>
  )
}
