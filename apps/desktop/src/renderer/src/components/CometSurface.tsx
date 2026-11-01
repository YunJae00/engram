import type { ReactNode } from 'react'
import { WebPane } from './WebPane.js'
import { BrowserTabs } from './BrowserTabs.js'

export function CometSurface({ channel, busy, onStop, children }: { channel: string; name: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  return <WebPane key={channel} channel={channel} busy={busy} onStop={onStop} toolbar={<BrowserTabs key={channel} channel={channel} busy={busy} />}>{children}</WebPane>
}
