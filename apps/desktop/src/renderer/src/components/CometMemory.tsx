import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BotFactDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

// What a comet remembers about the person, line by line, each one theirs to
// forget. Refreshes when the comet writes something new down.
export function CometMemory({ botId, name }: { botId: string; name: string }) {
  const [facts, setFacts] = useState<BotFactDto[] | null>(null)

  useEffect(() => {
    let live = true
    const load = () => void api.botMemory(botId).then((list) => live && setFacts(list)).catch(() => undefined)
    load()
    const off = api.onEvent((event) => {
      if (event.type === 'comet:remembered' && event.botId === botId) load()
    })
    return () => {
      live = false
      off()
    }
  }, [botId])

  const forget = (factId: string) => {
    setFacts((prior) => (prior ?? []).filter((f) => f.id !== factId))
    void api.botMemoryForget(botId, factId).catch(() => undefined)
  }

  return (
    <div className="bots-memory" data-testid="bots-memory">
      <div className="bots-memory-title">{t('bots.memoryTitle', { name })}</div>
      {facts && facts.length === 0 && <div className="bots-memory-empty">{t('bots.memoryEmpty')}</div>}
      {(facts ?? []).map((fact) => (
        <div key={fact.id} className="bots-memory-fact" data-testid={`bot-fact-${fact.id}`}>
          <span className="bots-memory-when">{fact.at.slice(0, 10)}</span>
          <span className="bots-memory-text">{fact.text}</span>
          <button
            className="bots-memory-forget"
            data-testid={`bot-fact-forget-${fact.id}`}
            aria-label={t('bots.factForget')}
            title={t('bots.factForget')}
            onClick={() => forget(fact.id)}
          >
            <X size={11} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
