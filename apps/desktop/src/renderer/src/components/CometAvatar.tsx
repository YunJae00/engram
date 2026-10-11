import { Comet, CometFace } from './Icon.js'

export function CometAvatar({ id, small = false, face = false }: { id: string; small?: boolean; face?: boolean }) {
  const tone = [...id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0) % 5
  const Mark = face ? CometFace : Comet
  return <span className={`comet-avatar${small ? ' small' : ''}`} data-tone={tone} aria-hidden><Mark size={small ? 17 : 25} /></span>
}
