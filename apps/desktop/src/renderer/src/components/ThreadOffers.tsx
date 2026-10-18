import { useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { useThreadT } from '../lib/useThreadT.js'
import { useCometState, useShellState } from '../state-slices.js'
import { Choices } from './Choices.js'
import { CometOffer } from './CometOffer.js'

// What a finished answer leaves for the person - choices for its question,
// or an offer to keep, run or repeat the job - wherever the conversation is
// shown, the full view or a split tile, with the same answers behind them.
export function ThreadOffers({ botId, onSend }: { botId: string; onSend(message: string): void }) {
  const { routine, startRoutine } = useCometState()
  const { showToast } = useShellState()
  const offer = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId).offer)
  const t = useThreadT(botId)
  if (!offer || routine.running) return null
  if (offer.kind === 'asked') return <Choices options={offer.options} t={t} onPick={(label) => { cometThreads.clearOffer(botId); onSend(label) }} />
  return (
    <CometOffer
      offer={offer}
      t={t}
      onKeep={async (name, goal) => {
        await api.botTaskAdd(botId, { name, goal })
        cometThreads.clearOffer(botId)
        showToast('Saved to Routines')
      }}
      onRun={(wanted) => { cometThreads.clearOffer(botId); void startRoutine(wanted.routineId, wanted.name, wanted.force === true, wanted.slots) }}
      onStand={(wanted) => {
        cometThreads.clearOffer(botId)
        void api.botTaskAdd(botId, { name: wanted.name, goal: wanted.goal, schedule: wanted.schedule, routineId: wanted.routineId }).catch(() => undefined)
      }}
      onDecline={(wanted) => { cometThreads.clearOffer(botId); void api.botStandingDecline(botId, wanted.goal).catch(() => undefined) }}
      onDismiss={() => cometThreads.clearOffer(botId)}
    />
  )
}
