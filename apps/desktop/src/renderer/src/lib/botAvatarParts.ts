import type { CharacterId } from '../../../../../../packages/core/src/bot-character.js'

// Literal URLs so the bundler copies exactly these files; a stored value never becomes a path.
export const CHARACTER_ART: Readonly<Record<CharacterId, { full: string; opt: string }>> = {
  '01-bean-tilt': { full: new URL('../assets/engram-chars/01-bean-tilt.png', import.meta.url).href, opt: new URL('../assets/engram-chars/01-bean-tilt@opt.png', import.meta.url).href },
  '02-cloud': { full: new URL('../assets/engram-chars/02-cloud.png', import.meta.url).href, opt: new URL('../assets/engram-chars/02-cloud@opt.png', import.meta.url).href },
  '03-cashew': { full: new URL('../assets/engram-chars/03-cashew.png', import.meta.url).href, opt: new URL('../assets/engram-chars/03-cashew@opt.png', import.meta.url).href },
  '04-lobe': { full: new URL('../assets/engram-chars/04-lobe.png', import.meta.url).href, opt: new URL('../assets/engram-chars/04-lobe@opt.png', import.meta.url).href },
  '05-squircle': { full: new URL('../assets/engram-chars/05-squircle.png', import.meta.url).href, opt: new URL('../assets/engram-chars/05-squircle@opt.png', import.meta.url).href },
  '06-triangle': { full: new URL('../assets/engram-chars/06-triangle.png', import.meta.url).href, opt: new URL('../assets/engram-chars/06-triangle@opt.png', import.meta.url).href },
  '07-oval': { full: new URL('../assets/engram-chars/07-oval.png', import.meta.url).href, opt: new URL('../assets/engram-chars/07-oval@opt.png', import.meta.url).href },
  '08-knob': { full: new URL('../assets/engram-chars/08-knob.png', import.meta.url).href, opt: new URL('../assets/engram-chars/08-knob@opt.png', import.meta.url).href },
  '09-pill': { full: new URL('../assets/engram-chars/09-pill.png', import.meta.url).href, opt: new URL('../assets/engram-chars/09-pill@opt.png', import.meta.url).href },
  '10-comma': { full: new URL('../assets/engram-chars/10-comma.png', import.meta.url).href, opt: new URL('../assets/engram-chars/10-comma@opt.png', import.meta.url).href },
  '11-peanut': { full: new URL('../assets/engram-chars/11-peanut.png', import.meta.url).href, opt: new URL('../assets/engram-chars/11-peanut@opt.png', import.meta.url).href },
  '12-crescent': { full: new URL('../assets/engram-chars/12-crescent.png', import.meta.url).href, opt: new URL('../assets/engram-chars/12-crescent@opt.png', import.meta.url).href },
  '13-donut': { full: new URL('../assets/engram-chars/13-donut.png', import.meta.url).href, opt: new URL('../assets/engram-chars/13-donut@opt.png', import.meta.url).href },
  '14-drop': { full: new URL('../assets/engram-chars/14-drop.png', import.meta.url).href, opt: new URL('../assets/engram-chars/14-drop@opt.png', import.meta.url).href },
  '15-hourglass': { full: new URL('../assets/engram-chars/15-hourglass.png', import.meta.url).href, opt: new URL('../assets/engram-chars/15-hourglass@opt.png', import.meta.url).href },
  '16-diamond': { full: new URL('../assets/engram-chars/16-diamond.png', import.meta.url).href, opt: new URL('../assets/engram-chars/16-diamond@opt.png', import.meta.url).href },
}
