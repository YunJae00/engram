import type { OrbId } from '../lib/botAvatar.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// Light only, no sphere, in the app icon's language (scripts/icon-art.mjs): two identical arcs of a circle (radius 40 of a 100-unit box), one at the top and one at the bottom.
// Every shape is a lune that is thickest at its middle and tapers to nothing at both ends, and each path holds the top lune and the same lune turned 180 degrees,
// so the mark is unchanged by a half turn. Layer 1 is the bloom, layer 2 the fringes (warm outside the circle, cool inside it), layer 3 the core.
// bot-orb.css blurs the layers and turns them; each layer's box reaches 25 units past the orb so the blur is not cut.
const BLOOM = 'M8 31.3A46 46 0 0 1 92 31.3A78 78 0 0 0 8 31.3ZM92 68.7A46 46 0 0 1 8 68.7A78 78 0 0 0 92 68.7Z'
const WARM = 'M11.7 29.6A43.4 43.4 0 0 1 88.3 29.6A52.5 52.5 0 0 0 11.7 29.6ZM88.3 70.4A43.4 43.4 0 0 1 11.7 70.4A52.5 52.5 0 0 0 88.3 70.4Z'
const COOL = 'M15 31.4A39.6 39.6 0 0 1 85 31.4A49.1 49.1 0 0 0 15 31.4ZM85 68.6A39.6 39.6 0 0 1 15 68.6A49.1 49.1 0 0 0 85 68.6Z'
const CORE = 'M15.1 28.2A41.1 41.1 0 0 1 84.9 28.2A48.2 48.2 0 0 0 15.1 28.2ZM84.9 71.8A41.1 41.1 0 0 1 15.1 71.8A48.2 48.2 0 0 0 84.9 71.8Z'

export function BotOrb({ orb, motion }: { orb: OrbId; motion: OrbMotion }) {
  return (
    <span className="bot-orb" data-orb={orb} data-motion={motion}>
      <span className="bot-orb-ribbons">
        <svg className="bot-orb-ribbon" viewBox="-25 -25 150 150" focusable="false">
          <path className="bot-orb-bloom" d={BLOOM} />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="-25 -25 150 150" focusable="false">
          <path className="bot-orb-warm" d={WARM} />
          <path className="bot-orb-cool" d={COOL} />
        </svg>
        <svg className="bot-orb-ribbon" viewBox="-25 -25 150 150" focusable="false">
          <path className="bot-orb-light" d={CORE} />
        </svg>
      </span>
    </span>
  )
}
