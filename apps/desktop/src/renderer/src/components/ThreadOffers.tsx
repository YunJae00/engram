import { useSyncExternalStore } from 'react'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { useThreadT } from '../lib/useThreadT.js'
import { Choices } from './Choices.js'

// What a finished answer leaves for the person: choices for a question it asked. Running, keeping or repeating a job is said in chat, never a card.
function CurrentOffer({ botId, onSend }: { botId: string; onSend(message: string): boolean }) {
  const offer = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId).offer)
  const t = useThreadT(botId)
  if (!offer) return null
  return <Choices options={offer.options} t={t} onPick={(label) => {
    if (cometThreads.thread(botId).offer !== offer || !onSend(label)) return
    // The send may already have closed it, and a newer offer is not this one's to clear.
    if (cometThreads.thread(botId).offer === offer) cometThreads.clearOffer(botId)
  }} />
}

export function ThreadOffers({ botId, onSend }: { botId: string; onSend(message: string): boolean }) {
  const unapplied = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId).unapplied)
  const t = useThreadT(botId)
  return <>
    {unapplied.length > 0 && <section aria-label={t('aside.unapplied')}>
      <p>{t('aside.unapplied')}</p>
      <Choices options={unapplied} t={t} onPick={text => {
        if (!cometThreads.thread(botId).unapplied.includes(text) || !onSend(text)) return
        if (cometThreads.thread(botId).unapplied.includes(text)) cometThreads.clearUnapplied(botId, text)
      }} />
    </section>}
    <CurrentOffer botId={botId} onSend={onSend} />
  </>
}
