import type { ReactNode } from 'react'
import { WebPane } from './WebPane.js'

// The chat's side surface is the browser. Computer work happens on the real
// screen, announced by the overlay, and needs no pane here.
export function CometSurface({ channel, busy, onStop, children }: { channel: string; name: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  return <WebPane key={channel} channel={channel} busy={busy} onStop={onStop}>{children}</WebPane>
}
