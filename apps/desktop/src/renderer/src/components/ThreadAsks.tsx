import { cometChannel } from '../lib/cometThreads.js'
import { HabitAsk } from './HabitAsk.js'
import { PressGate } from './PressGate.js'
import { RoutineProgress } from './RoutineProgress.js'
import { SubmitGate } from './SubmitGate.js'
import { TaskApprovals } from './TaskApprovals.js'

// What the comet needs from the person right now - a press to allow, a post
// to look over, a sign-in, an answer - said in the conversation itself, as
// its next message, wherever the conversation is shown.
export function ThreadAsks({ botId, questionShown }: { botId: string; questionShown?: string }) {
  const channel = cometChannel(botId)
  return <>
    <RoutineProgress channel={channel} />
    <SubmitGate channel={channel} />
    <PressGate channel={channel} />
    <TaskApprovals botId={botId} questionShown={questionShown} />
    <HabitAsk key={botId} botId={botId} />
  </>
}
