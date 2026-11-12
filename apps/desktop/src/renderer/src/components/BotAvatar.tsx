import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { avatarCharacter, characterSrc, FALLBACK_CHARACTER } from '../lib/botAvatar.js'
import type { CometActivity } from '../lib/cometActivity.js'

export type BotAvatarProps = {
  id: string
  override?: unknown
  primary?: boolean
  size: 20 | 24 | 32 | 36 | 48 | 64 | 96
  state: 'idle' | 'working' | 'attention'
  theme: 'light' | 'dark'
}

const useMeasure = typeof document === 'undefined' ? useEffect : useLayoutEffect

export function BotAvatar({ id, override, primary, size, state }: BotAvatarProps) {
  const character = avatarCharacter(id, override)
  const [failed, setFailed] = useState<string | null>(null)
  const [shown, setShown] = useState<number>(size)
  const box = useRef<HTMLSpanElement>(null)
  // CSS can scope a caller's size (sidebar 24, header 32); the file follows the size actually drawn.
  useMeasure(() => {
    const width = box.current?.getBoundingClientRect().width
    if (width) setShown(Math.round(width))
  })
  const face = failed === character ? FALLBACK_CHARACTER : character
  return (
    <span ref={box} className="bot-avatar" data-size={size} data-state={state} data-character={face} aria-hidden="true">
      <span className="bot-avatar-art">
        <img className="bot-avatar-img" alt="" draggable={false} src={characterSrc(face, shown)} onError={() => { if (face !== FALLBACK_CHARACTER) setFailed(character) }} />
      </span>
      {state === 'attention' && <span className="bot-avatar-alert" />}
      {primary === true && size >= 36 && <span className="bot-avatar-primary" />}
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
