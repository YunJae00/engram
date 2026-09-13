import { useMemo, useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { useCometState } from '../state-slices.js'
import { activitySnapshot, type CometActivity } from './cometActivity.js'
import { cometChannel } from './cometThreads.js'
import { cometThreads } from './cometThreadsLive.js'

const snapshot = () => activitySnapshot(cometThreads.getSnapshot().threads)

export function useCometActivity() {
  const value = useSyncExternalStore(cometThreads.subscribe, snapshot)
  const states = useMemo(() => new Map<string, CometActivity>(JSON.parse(value)), [value])
  const { pressAsks, routineSubmit, routineWall } = useCometState()
  return (bot: BotDto, active = false): CometActivity => {
    const state = states.get(bot.id) ?? (active ? 'running' : 'ready')
    if (state !== 'running') return state
    const waiting = pressAsks.some((ask) => ask.channel === cometChannel(bot.id))
      || routineSubmit?.channel === cometChannel(bot.id)
      || routineWall?.channel === cometChannel(bot.id)
    return waiting ? 'waiting' : state
  }
}
