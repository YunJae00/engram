import type { CometThread } from './cometThreads.js'

export type CometActivity = 'ready' | 'running' | 'waiting' | 'error'

export function cometActivity(thread: CometThread | undefined, active = false, waiting = false): CometActivity {
  const running = thread?.busy || (active && !thread?.stopped)
  if (running && waiting) return 'waiting'
  if (running) return 'running'
  return thread?.messages.at(-1)?.error ? 'error' : 'ready'
}

// Tokens, work lines and drafts do not change the activity snapshot.
export function activitySnapshot(threads: Readonly<Record<string, CometThread>>): string {
  return JSON.stringify(Object.entries(threads).map(([id, thread]) => [id, cometActivity(thread)]))
}
