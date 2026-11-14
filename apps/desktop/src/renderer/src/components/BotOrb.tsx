import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

const RIBBON = 'M8 50C22 20 40 24 50 50C60 76 78 80 92 50C78 66 62 60 50 50C38 40 22 34 8 50Z'

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        {[0, 1, 2].map(i => <svg key={i} className="bot-orb-ribbon" viewBox="0 0 100 100" focusable="false"><path d={RIBBON} /></svg>)}
      </span>
      <span className="bot-orb-core" />
    </span>
  )
}
