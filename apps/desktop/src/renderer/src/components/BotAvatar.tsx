import type { ReactNode } from 'react'
import { avatarSpec, blush, CRATERS, PALETTES, paletteOf, PATHS, type DrawnSpec } from '../lib/botAvatar.js'

export type BotAvatarProps = {
  id: string
  override?: unknown
  primary?: boolean
  size: 20 | 36 | 64 | 96
  state: 'idle' | 'working' | 'attention'
  theme: 'light' | 'dark'
  imageUrl?: string
}

type Ink = { fill: string; line: string; ink: string; theme: 'light' | 'dark' }
const WHITE = '#FFFFFF'
const SURPRISED = 4
const DOT_EYES = [true, false, true, false, true, false] as const

function Body({ body, size, c }: { body: DrawnSpec['body']; size: number; c: Ink }): ReactNode {
  const disc = <circle cx={48} cy={52} r={30} fill={c.fill} stroke={c.line} strokeWidth={3} />
  const detail = size >= 36
  if (body === 'sun') return <><path d={PATHS.sunRays} stroke={c.line} strokeWidth={6} strokeLinecap="round" />{disc}</>
  if (body === 1) {
    const ring = { fill: 'none', stroke: c.line, strokeWidth: 4, transform: 'rotate(-20 48 52)' }
    return <><ellipse cx={48} cy={52} rx={44} ry={10} {...ring} />{disc}{detail && <path d={PATHS.ringFront} {...ring} />}</>
  }
  if (body === 2) return <><path d={PATHS.cometTails} stroke={c.line} strokeWidth={7} strokeLinecap="round" />{disc}</>
  if (body === 4) return <path d={PATHS.star} fill={c.fill} stroke={c.line} strokeWidth={3} strokeLinejoin="round" />
  if (body === 5) return <><path d={PATHS.nebula} stroke={c.line} strokeWidth={6} /><path d={PATHS.nebula} fill={c.fill} /></>
  if (!detail) return disc
  if (body === 3) return <>{disc}{CRATERS.map(([x, y, r]) => <circle key={x} cx={x} cy={y} r={r} fill={c.line} opacity={0.3} />)}</>
  return <>{disc}<path d={PATHS.planetShade} fill={c.line} opacity={0.25} /></>
}

function Eyes({ face, size, ink }: { face: number; size: number; ink: string }): ReactNode {
  const sw = size === 20 ? 6 : size === 36 ? 4 : 3
  const r = size === 20 ? 7 : 5
  const line = { fill: 'none', stroke: ink, strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const dot = (x: number) => <circle cx={x} cy={50} r={r} fill={ink} />
  if (face === 0) return <>{dot(38)}{dot(58)}</>
  if (face === 1) return <><path d={PATHS.happyLeft} {...line} /><path d={PATHS.happyRight} {...line} /></>
  if (face === 2) return <>{dot(38)}<path d={PATHS.winkRight} {...line} /></>
  if (face === 3) return <><path d={PATHS.dashLeft} {...line} /><path d={PATHS.dashRight} {...line} /></>
  if (face === 4) return <><circle cx={38} cy={50} r={r} {...line} /><circle cx={58} cy={50} r={r} {...line} /></>
  return <><path d={PATHS.calmLeft} {...line} /><path d={PATHS.calmRight} {...line} /></>
}

function Mouth({ face, ink }: { face: number; ink: string }): ReactNode {
  if (face === 3) return <circle cx={48} cy={62} r={3} fill="none" stroke={ink} strokeWidth={3} />
  if (face === 4) return <circle cx={48} cy={63} r={4} fill={ink} />
  return <path d={face === 1 ? PATHS.grin : PATHS.smile} fill="none" stroke={ink} strokeWidth={3} strokeLinecap="round" />
}

function Accessory({ kind, full, c }: { kind: number; full: boolean; c: Ink }): ReactNode {
  const accent = (palette: number) => PALETTES[palette]![c.theme].fill
  const edge = { stroke: c.line, strokeWidth: 3, strokeLinejoin: 'round' as const }
  const stroke = (width: number) => ({ fill: 'none', stroke: c.line, strokeWidth: width, strokeLinecap: 'round' as const })
  switch (kind) {
    case 1: return <><path d={PATHS.headsetBand} {...stroke(4)} />{full && <><rect x={12} y={42} width={9} height={15} rx={4} fill={accent(7)} {...edge} /><rect x={75} y={42} width={9} height={15} rx={4} fill={accent(7)} {...edge} /></>}<path d={PATHS.headsetMic} {...stroke(3)} /></>
    case 2: return <path d={PATHS.glasses} fill="none" stroke={c.ink} strokeWidth={full ? 3 : 4} />
    case 3: return <><path d={PATHS.pencil} fill={accent(2)} {...edge} />{full && <path d={PATHS.pencilTip} fill={c.ink} />}</>
    case 4: return <><circle cx={72} cy={74} r={9} fill={WHITE} {...edge} /><path d={PATHS.magnifierHandle} {...stroke(5)} /></>
    case 5: return <><rect x={62} y={66} width={24} height={22} rx={4} fill={WHITE} {...edge} /><rect x={62} y={66} width={24} height={7} rx={3} fill={accent(0)} />{full && <path d={PATHS.calendarRings} {...stroke(3)} />}</>
    case 6: return <><rect x={60} y={70} width={24} height={20} rx={3} fill={accent(5)} {...edge} />{full && <path d={PATHS.bookPages} {...stroke(2)} />}</>
    case 7: return <><path d={PATHS.cup} fill={accent(1)} {...edge} />{full && <><path d={PATHS.cupHandle} {...stroke(3)} /><path d={PATHS.steam} {...stroke(2)} /></>}</>
    case 8: return <><rect x={60} y={68} width={26} height={19} rx={3} fill={WHITE} {...edge} /><path d={PATHS.envelopeFlap} {...stroke(2)} /></>
    default: return null
  }
}

function Drawn({ spec, size, state, theme }: { spec: DrawnSpec; size: number; state: BotAvatarProps['state']; theme: 'light' | 'dark' }) {
  const p = paletteOf(spec.palette)
  const c: Ink = { ...p[theme], ink: p.ink, theme }
  const face = state === 'attention' ? SURPRISED : spec.face
  const big = size >= 64
  const glints = size >= 36 && DOT_EYES[face]
  const eyes = <><Eyes face={face} size={size} ink={c.ink} />{glints && <><circle cx={40} cy={48} r={1.8} fill={WHITE} />{face !== 2 && <circle cx={60} cy={48} r={1.8} fill={WHITE} />}</>}</>
  const cheek = big ? blush(c.fill, PALETTES[0]![theme].fill) : ''
  return (
    <svg viewBox="0 0 96 96" width="100%" height="100%">
      <Body body={spec.body} size={size} c={c} />
      {big && <ellipse cx={38} cy={34} rx={9} ry={5} fill={WHITE} opacity={0.35} transform="rotate(-30 38 34)" />}
      {big && <><ellipse cx={29} cy={60} rx={6} ry={3.5} fill={cheek} /><ellipse cx={67} cy={60} rx={6} ry={3.5} fill={cheek} /></>}
      {big ? <g className="bot-avatar-eyes">{eyes}</g> : eyes}
      {size >= 36 && <Mouth face={face} ink={c.ink} />}
      {big && spec.accessory === 0 && <><ellipse cx={22} cy={72} rx={5} ry={4} fill={c.fill} stroke={c.line} strokeWidth={2} /><ellipse cx={74} cy={72} rx={5} ry={4} fill={c.fill} stroke={c.line} strokeWidth={2} /></>}
      {size >= 36 && <Accessory kind={spec.accessory} full={big} c={c} />}
    </svg>
  )
}

export function BotAvatar({ id, override, primary, size, state, theme, imageUrl }: BotAvatarProps) {
  const isPrimary = primary === true
  const spec = avatarSpec(id, override, isPrimary)
  const showImage = spec.kind === 'image' && typeof imageUrl === 'string' && imageUrl !== ''
  const drawn = spec.kind === 'drawn' ? spec : avatarSpec(id, undefined, isPrimary) as DrawnSpec
  return (
    <span className="bot-avatar" data-size={size} data-state={state} aria-hidden="true">
      <span className="bot-avatar-art">
        {showImage ? <img className="bot-avatar-img" alt="" src={imageUrl} /> : <Drawn spec={drawn} size={size} state={state} theme={theme} />}
      </span>
      {state === 'attention' && <span className="bot-avatar-alert" />}
      {isPrimary && size >= 36 && <span className="bot-avatar-primary" />}
    </span>
  )
}
