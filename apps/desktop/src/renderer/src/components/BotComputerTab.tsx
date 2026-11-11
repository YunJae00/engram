import { useEffect, useState, type ReactNode } from 'react'
import type { BotDto, BrowserTabDto } from '../../../shared/types.js'
import type { DesktopBindingDto, DesktopControlStatusDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometChannel } from '../lib/cometThreads.js'
import { useDesktopSession } from '../lib/desktopSession.js'
import { computerStateLabel } from './ComputerStatus.js'

export function browserTabRows(value: unknown): BrowserTabDto[] {
  if (!Array.isArray(value)) return []
  const rows: BrowserTabDto[] = []
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    if (typeof item !== 'object' || item === null) continue
    const { id, url, title, active } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof url !== 'string') continue
    rows.push({ id, url, active: active === true, ...(typeof title === 'string' ? { title } : {}) })
  }
  return rows
}

export function laneBinding(bindings: unknown, lane: string): DesktopBindingDto | undefined {
  if (!Array.isArray(bindings)) return undefined
  for (let i = 0; i < bindings.length; i++) {
    const item: unknown = bindings[i]
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.lane === lane && typeof row.name === 'string') return item as DesktopBindingDto
  }
  return undefined
}

function tabLabel(tab: BrowserTabDto): string {
  if (tab.title) return tab.title
  try {
    const url = new URL(tab.url)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname
  } catch { /* not a URL */ }
  return t('botInfo.newTab')
}

export function BotComputerView({ tabs, binding, control, empty }: { tabs: BrowserTabDto[]; binding?: DesktopBindingDto; control?: DesktopControlStatusDto; empty: ReactNode }) {
  if (!tabs.length && !binding && !control) return <>{empty}</>
  return (
    <div data-testid="bot-computer">
      {tabs.length > 0 && (
        <section data-testid="bot-computer-tabs">
          <h3>{t('botInfo.browserTabs')}</h3>
          <ul>{tabs.map(tab => <li key={tab.id} data-testid="bot-computer-tab" data-active={tab.active} title={tab.url}>{tabLabel(tab)}</li>)}</ul>
        </section>
      )}
      {(binding || control) && (
        <section data-testid="bot-computer-desktop">
          <h3>{t('botInfo.desktop')}</h3>
          {binding && <p data-testid="bot-computer-window">{binding.name}</p>}
          {control && <p data-testid="bot-computer-control">{computerStateLabel(control)}</p>}
        </section>
      )}
    </div>
  )
}

export function BotComputerTab({ bot, empty }: { bot: BotDto; empty: ReactNode }) {
  const lane = cometChannel(bot.id)
  const { bindings, control } = useDesktopSession()
  const [tabs, setTabs] = useState<BrowserTabDto[]>([])
  useEffect(() => {
    let current = true
    let received = false
    const off = api.onEvent(event => {
      if (event.type !== 'agent:tabs' || event.lane !== lane) return
      received = true
      setTabs(browserTabRows(event.tabs))
    })
    void api.browserTabs(lane).then(result => { if (current && !received) setTabs(browserTabRows(result)) }).catch(() => {})
    return () => { current = false; off() }
  }, [lane])
  const shown = control && control.lane === lane && control.state !== 'idle' ? control : undefined
  return <BotComputerView tabs={tabs} binding={laneBinding(bindings, lane)} control={shown} empty={empty} />
}
