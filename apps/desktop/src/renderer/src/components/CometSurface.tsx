import type { ReactNode } from 'react'
import { WebPane } from './WebPane.js'

export function CometSurface({ channel, busy, onStop, children }: { channel: string; name: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  return <WebPane key={channel} channel={channel} busy={busy} onStop={onStop}>{children}</WebPane>
}
