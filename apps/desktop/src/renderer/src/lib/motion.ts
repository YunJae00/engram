import { useSyncExternalStore } from 'react'

export const MOTION_MS = 160
const preference = () => window.matchMedia('(prefers-reduced-motion: reduce)')
const subscribe = (notify: () => void) => {
  const query = preference()
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
export const useReducedMotion = () => useSyncExternalStore(subscribe, () => preference().matches, () => false)
