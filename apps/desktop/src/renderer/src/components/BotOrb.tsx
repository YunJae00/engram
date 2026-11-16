import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// Light only, no sphere, two identical arcs of a circle (radius 40 of a 100-unit box), one at the top and one at the bottom.
// Every arc shape is a lune that is thickest at its middle and tapers to nothing at both ends, and each path holds the top lune and the same lune turned 180 degrees,
// so the mark is unchanged by a half turn. From the back: the air inside the circle and the far bloom, the two fringes (warm outside the circle, cool inside it),
// the band (the body of the light), the filament (a hairline core), and the bead (a caustic that slides along the arc).
// bot-orb.css blurs the layers and turns them; each layer's box reaches 25 units past the orb so the blur is not cut.
const AIR = 'M22 50a28 28 0 1 0 56 0a28 28 0 1 0 -56 0Z'
const BLOOM = 'M11.2 40.3A38.8 38.8 0 0 1 88.8 40.3A44.9 44.9 0 0 0 11.2 40.3ZM88.8 59.7A38.8 38.8 0 0 1 11.2 59.7A44.9 44.9 0 0 0 88.8 59.7Z'
const WARM = 'M12.2 37A38.5 38.5 0 0 1 87.8 37A39.8 39.8 0 0 0 12.2 37ZM87.8 63A38.5 38.5 0 0 1 12.2 63A39.8 39.8 0 0 0 87.8 63Z'
const COOL = 'M12.2 37A40.3 40.3 0 0 1 87.8 37A43.1 43.1 0 0 0 12.2 37ZM87.8 63A40.3 40.3 0 0 1 12.2 63A43.1 43.1 0 0 0 87.8 63Z'
const BAND = 'M12.7 35.7A39.1 39.1 0 0 1 87.3 35.7A41.2 41.2 0 0 0 12.7 35.7ZM87.3 64.3A39.1 39.1 0 0 1 12.7 64.3A41.2 41.2 0 0 0 87.3 64.3Z'
const FILAMENT = 'M13.7 33.1A39.6 39.6 0 0 1 86.3 33.1A40.4 40.4 0 0 0 13.7 33.1ZM86.3 66.9A39.6 39.6 0 0 1 13.7 66.9A40.4 40.4 0 0 0 86.3 66.9Z'
const BEAD = 'M36.3 12.4A21.9 21.9 0 0 1 63.7 12.4A7611.3 7611.3 0 0 0 36.3 12.4ZM63.7 87.6A21.9 21.9 0 0 1 36.3 87.6A7611.3 7611.3 0 0 0 63.7 87.6Z'

const LAYERS = [
  [['bot-orb-air', AIR], ['bot-orb-bloom', BLOOM]],
  [['bot-orb-warm', WARM], ['bot-orb-cool', COOL]],
  [['bot-orb-band', BAND]],
  [['bot-orb-light', FILAMENT]],
  [['bot-orb-bead', BEAD]],
] as const

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        {LAYERS.map((paths, layer) => (
          <svg key={layer} className="bot-orb-ribbon" viewBox="-25 -25 150 150" focusable="false">
            {paths.map(([name, d]) => <path key={name} className={name} d={d} />)}
          </svg>
        ))}
      </span>
    </span>
  )
}
