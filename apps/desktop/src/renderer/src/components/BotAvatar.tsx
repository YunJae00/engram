import type { ReactNode } from 'react'
import { avatarSpec, paletteOf, PATHS, type DrawnSpec } from '../lib/botAvatar.js'
import { useSyncExternalStore } from 'react'
import type { CometActivity } from '../lib/cometActivity.js'
import { useBotImage } from '../lib/botImage.js'

export type BotAvatarProps = {
  id: string
  override?: unknown
  primary?: boolean
  size: 20 | 36 | 64 | 96
  state: 'idle' | 'working' | 'attention'
  theme: 'light' | 'dark'
  imageUrl?: string
}

const SURPRISED = 4
const STROKE = 8

// [rx, ry, tilt degrees, centre gap]; face 4 is the roundest, most open pair.
const FACES = [[4.5, 8.5, -15, 16], [4, 9, -20, 15], [5, 7.5, -10, 17], [4, 7, -25, 14], [6, 8, -8, 18], [4.5, 9.5, -28, 17]] as const
// [eye midpoint x, eye y] per body, keeping both eyes inside its fill.
const ANCHORS: Record<DrawnSpec['body'], readonly [number, number]> = {
  sun: [54, 40], 0: [54, 38], 1: [53, 38], 2: [58, 44], 3: [60, 38], 4: [50, 46], 5: [54, 38],
}

function Body({ body }: { body: DrawnSpec['body'] }): ReactNode {
  if (body === 'sun') return <><circle cx={48} cy={48} r={30} /><path d={PATHS.sunRays} /></>
  if (body === 1) return <><circle cx={48} cy={47} r={27} /><path d={PATHS.ring} fillRule="evenodd" transform="rotate(-18 48 50)" /></>
  if (body === 2) return <path d={PATHS.comet} />
  if (body === 3) return <path d={PATHS.moon} />
  if (body === 4) return <path d={PATHS.star} />
  if (body === 5) return <><circle cx={34} cy={58} r={22} /><circle cx={63} cy={58} r={21} /><circle cx={50} cy={36} r={24} /></>
  return <rect x={12} y={16} width={72} height={66} rx={33} />
}

function Eyes({ face, body }: { face: number; body: DrawnSpec['body'] }): ReactNode {
  const [rx, ry, tilt, gap] = FACES[face] ?? FACES[0]
  const [mx, cy] = ANCHORS[body] ?? [54, 38]
  const eye = (cx: number) => <ellipse cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${tilt} ${cx} ${cy})`} />
  return <g className="bot-avatar-eyes" fill="#FFFFFF">{eye(mx - gap / 2)}{eye(mx + gap / 2)}</g>
}

function Drawn({ spec, state, theme }: { spec: DrawnSpec; state: BotAvatarProps['state']; theme: 'light' | 'dark' }) {
  const fill = paletteOf(spec.palette)[theme].fill
  return (
    <svg viewBox="0 0 96 96" width="100%" height="100%">
      <g className="bot-avatar-body" fill={fill} stroke={fill} strokeWidth={STROKE} strokeLinejoin="round"><Body body={spec.body} /></g>
      <Eyes face={state === 'attention' ? SURPRISED : spec.face} body={spec.body} />
    </svg>
  )
}

export function BotAvatar({ id, override, primary, size, state, theme, imageUrl }: BotAvatarProps) {
  const isPrimary = primary === true
  const spec = avatarSpec(id, override, isPrimary)
  const fetched = useBotImage(id, spec.kind === 'image' && !imageUrl ? spec.image : null)
  const url = imageUrl || fetched
  const showImage = spec.kind === 'image' && typeof url === 'string' && url !== ''
  const drawn = spec.kind === 'drawn' ? spec : avatarSpec(id, undefined, isPrimary) as DrawnSpec
  return (
    <span className="bot-avatar" data-size={size} data-state={state} aria-hidden="true">
      <span className="bot-avatar-art">
        {showImage ? <img className="bot-avatar-img" alt="" src={url} /> : <Drawn spec={drawn} state={state} theme={theme} />}
      </span>
      {state === 'attention' && <span className="bot-avatar-alert" />}
      {isPrimary && size >= 36 && <span className="bot-avatar-primary" />}
    </span>
  )
}

export function avatarState(activity: CometActivity): BotAvatarProps['state'] {
  if (activity === 'running') return 'working'
  if (activity === 'waiting' || activity === 'error') return 'attention'
  return 'idle'
}

const themeOf = (): 'light' | 'dark' => (document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light')
const lightTheme = (): 'light' => 'light'
function watchTheme(change: () => void): () => void {
  const observer = new MutationObserver(change)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

export function useAvatarTheme(): 'light' | 'dark' {
  return useSyncExternalStore(watchTheme, themeOf, lightTheme)
}
