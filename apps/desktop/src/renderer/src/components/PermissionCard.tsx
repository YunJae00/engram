import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { api } from '../api.js'
import type { PermissionCardDto } from '../../../shared/types.js'
import { DecisionCard } from './DecisionCard.js'

export function PermissionCard({ lane }: { lane: string }) {
  const [card, setCard] = useState<PermissionCardDto | null>(null)
  useEffect(() => {
    // A push that lands while the fetch is in flight is newer than the fetch.
    let heard = false
    setCard(null)
    const off = api.onPermissionCard((from, next) => { if (from === lane) { heard = true; setCard(next) } })
    void api.desktopPermissionCard(lane).then(next => { if (!heard) setCard(next) }, () => undefined)
    return () => { heard = true; off() }
  }, [lane])
  if (!card) return null
  return (
    <div className="permission-card" lang={card.lang}>
      <DecisionCard testId="permission-card" tone="info" icon={<ShieldAlert size={14} />} label={card.label} title={card.title} sub={card.why}
        actions={<button className="primary" data-testid="permission-card-open" onClick={() => void api.desktopPermissionPane(card.permission).catch(() => undefined)}>{card.button}</button>} />
    </div>
  )
}
