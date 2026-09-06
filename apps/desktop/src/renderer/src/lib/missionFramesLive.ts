import { api } from '../api.js'
import type { MissionFrameDto } from '../../../shared/types.js'

// Pixel delivery is separate from React state; a scrolling page must not
// rerender four conversations or their composers for every video frame.
const held = new Map<string, MissionFrameDto>()
const watchers = new Map<string, Set<(frame: MissionFrameDto) => void>>()

api.onEvent((event) => {
  if (event.type !== 'mission:frame') return
  const { frame } = event
  const previous = held.get(frame.lane)
  const next = { ...previous, ...frame }
  held.delete(frame.lane)
  held.set(frame.lane, next)
  if (held.size > 8) held.delete(held.keys().next().value!)
  for (const watcher of watchers.get(frame.lane) ?? []) watcher(next)
})

export function onMissionFrame(lane: string, receive: (frame: MissionFrameDto) => void): () => void {
  const listeners = watchers.get(lane) ?? new Set()
  watchers.set(lane, listeners)
  listeners.add(receive)
  const previous = held.get(lane)
  if (previous) receive(previous)
  return () => {
    listeners.delete(receive)
    if (!listeners.size) watchers.delete(lane)
  }
}
