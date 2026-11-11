import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, uiLocale } from '../i18n.js'
import type { CometMessage } from '../lib/cometThreads.js'
import { useShellState } from '../state-slices.js'
import { CometMessages } from './CometMessages.js'

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/
const PARTS = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/

function stampLabel(stamp: string): string {
  const m = PARTS.exec(stamp)
  if (!m) return stamp
  const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)
  return Number.isNaN(date.getTime()) ? stamp : new Intl.DateTimeFormat(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function stamps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const row: unknown = value[i]
    const stamp = typeof row === 'object' && row !== null ? (row as { stamp?: unknown }).stamp : undefined
    if (typeof stamp === 'string' && STAMP.test(stamp)) out.push(stamp)
  }
  return out
}

function turns(value: unknown[]): CometMessage[] {
  const out: CometMessage[] = []
  for (let i = 0; i < value.length; i++) {
    const turn: unknown = value[i]
    if (typeof turn !== 'object' || turn === null) continue
    const { role, text, progress, at } = turn as { role?: unknown; text?: unknown; progress?: unknown; at?: unknown }
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') continue
    if (role === 'assistant' && progress === true) continue
    out.push({ role, text, ...(typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? { at } : {}) })
  }
  return out
}

export function BotPastTab({ bot, active, empty }: { bot: BotDto; active: boolean; empty: ReactNode }) {
  const { showToast } = useShellState()
  const toast = useRef(showToast)
  toast.current = showToast
  const [rows, setRows] = useState<string[] | null>(null)
  const [view, setView] = useState<CometMessage[] | null>(null)
  const listing = useRef(0)
  const opening = useRef(0)

  useEffect(() => () => { listing.current++; opening.current++ }, [])
  useEffect(() => {
    if (!active) return
    const n = ++listing.current
    api.botConversations(bot.id).then(
      (value: unknown) => { if (n === listing.current) setRows(stamps(value)) },
      (error: unknown) => { if (n === listing.current) { setRows([]); toast.current(String(error)) } })
  }, [active, bot.id])

  const open = (stamp: string) => {
    const n = ++opening.current
    api.botArchivedTranscript(bot.id, stamp).then((value: unknown) => {
      if (n !== opening.current) return
      if (!Array.isArray(value)) { toast.current(String(value)); return }
      setView(turns(value))
    }, (error: unknown) => { if (n === opening.current) toast.current(String(error)) })
  }
  const back = () => { opening.current++; setView(null) }

  if (view) return (
    <div data-testid="bot-past-view">
      <button type="button" className="secondary" data-testid="bot-past-back" aria-label={t('botInfo.past')} onClick={back}><ArrowLeft size={14} aria-hidden /></button>
      <div className="bots-thread conversation-thread">
        <CometMessages messages={view} busy={false} status="" workLines={[]} keptWork={[]} />
      </div>
    </div>
  )
  if (!rows?.length) return <>{empty}</>
  return (
    <div data-testid="bot-past-list">
      {rows.map(stamp => <button key={stamp} type="button" className="secondary" data-testid="bot-past-item" onClick={() => open(stamp)}>{stampLabel(stamp)}</button>)}
    </div>
  )
}
