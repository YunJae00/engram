import { AlertTriangle } from 'lucide-react'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useThreadT } from '../lib/useThreadT.js'
import { useCometState } from '../state-slices.js'
import { DecisionCard } from './DecisionCard.js'

// A comet at a control that would commit something: it stops and asks. The
// page is on screen right above this, so the question needs no description
// of what is about to happen - the person looks. They can let it go, let it
// go on this site from now on, or take the press themselves in that view.

export function PressGate({ channel }: { channel: string }) {
  const { pressAsks, answerPressAsk } = useCometState()
  const t = useThreadT(cometOfChannel(channel))
  const pressAsk = pressAsks.find((ask) => ask.channel === channel)
  if (!pressAsk) return null
  // Allowing a site for good is a deliberate choice, folded under the site's
  // name, away from the two everyday answers.
  return (
    <DecisionCard
      testId="press-ask"
      icon={<AlertTriangle size={14} />}
      label={t('card.needsOk')}
      title={t('card.press', { words: pressAsk.words })}
      hint={t('press.askHint')}
      sub={pressAsk.host && <details className="decision-card-more"><summary>{pressAsk.host}</summary><button className="decision-card-link" data-testid="press-ask-always" onClick={() => answerPressAsk(channel, 'always')}>{t('press.always', { host: pressAsk.host })}</button></details>}
      actions={<>
        <button className="secondary" data-testid="press-ask-mine" onClick={() => answerPressAsk(channel, 'cancel')}>{t('press.mine')}</button>
        <button className="primary" data-testid="press-ask-go" onClick={() => answerPressAsk(channel, 'approve')}>{t('press.go')}</button>
      </>}
    />
  )
}
