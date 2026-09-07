import { CircleAlert, LoaderCircle, Pause } from 'lucide-react'
import { t } from '../i18n.js'
import type { CometActivity } from '../lib/cometActivity.js'

export function cometActivityLabel(state: CometActivity): string {
  return t(state === 'error' ? 'mission.stateError' : state === 'waiting' ? 'mission.stateWaiting' : `mission.${state}`)
}

export function CometActivityIndicator({ state }: { state: CometActivity }) {
  if (state === 'ready') return null
  const Icon = state === 'running' ? LoaderCircle : state === 'waiting' ? Pause : CircleAlert
  return <Icon className="comet-activity-icon" data-state={state} size={14} role="img" aria-label={cometActivityLabel(state)} />
}
