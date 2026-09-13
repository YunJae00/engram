import { Comet } from './Icon.js'

export function CometAvatar({ id, small = false }: { id: string; small?: boolean }) {
  const tone = [...id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0) % 5
  return <span className={`comet-avatar${small ? ' small' : ''}`} data-tone={tone} aria-hidden><Comet size={small ? 17 : 25} /></span>
}
