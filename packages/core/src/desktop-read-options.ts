import { plainRecord } from './tool-args.js'

export interface DesktopReadOptions { mode?: 'full' | 'skeleton'; root?: string; snapshot?: string }
export const DESKTOP_READ_PROPERTIES = {
  mode: { type: 'string', enum: ['full', 'skeleton'] },
  root: { type: 'string', pattern: '^[cte][0-9]{1,5}$' },
  snapshot: { type: 'string', pattern: '^[a-f0-9]{32}$' },
}
export const DESKTOP_READ_GUIDANCE = 'For large apps, read mode:skeleton first, then pass root and snapshot from that reading to inspect only the target subtree; truncated containers need a narrower reading.'
export function desktopReadOptions(args: unknown): DesktopReadOptions | null {
  if (!plainRecord(args)) return null
  const { mode, root, snapshot } = args
  if (mode !== undefined && mode !== 'full' && mode !== 'skeleton') return null
  if ((root !== undefined) !== (snapshot !== undefined)) return null
  if (root !== undefined && (mode === 'skeleton' || typeof root !== 'string' || !/^[cte][0-9]{1,5}$/.test(root) || typeof snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(snapshot))) return null
  return { ...(mode ? { mode } : {}), ...(typeof root === 'string' && typeof snapshot === 'string' ? { root, snapshot } : {}) }
}
