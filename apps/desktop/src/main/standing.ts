import { dueNow, loadBots, markBotTaskRun, type VaultPaths } from 'core'

// Standing tasks run themselves: once a minute the comets' tasks are read
// off disk, and the ones due on this day at this hour start through the same
// door a press of Run uses - the same guards, the same gate, the same
// window on screen. Nothing new is held in memory between ticks.

export const STANDING_TICK_MS = 60_000

export interface StandingDeps {
  paths: VaultPaths
  // The routine door. `blocked` is the person's own earlier decision for the
  // day (a rerun refused), which counts as run; any other refusal is a
  // moment's trouble and is tried again next tick.
  runRoutine(id: string): Promise<{ ok: boolean; blocked?: boolean }>
  now?(): Date
}

export async function standingTick(deps: StandingDeps): Promise<string[]> {
  const now = deps.now?.() ?? new Date()
  const started: string[] = []
  for (const bot of await loadBots(deps.paths)) {
    for (const task of bot.tasks ?? []) {
      if (!task.schedule || !task.routineId || !dueNow(task.schedule, task.lastRunAt, now)) continue
      const reply = await deps.runRoutine(task.routineId)
      if (!reply.ok && !reply.blocked) continue
      await markBotTaskRun(deps.paths, bot.id, task.id, now)
      if (reply.ok) started.push(task.id)
      // One at a time: the browser is one window and the model one process.
      return started
    }
  }
  return started
}

let timer: NodeJS.Timeout | null = null

export function startStanding(deps: StandingDeps): void {
  stopStanding()
  timer = setInterval(() => void standingTick(deps).catch(() => undefined), STANDING_TICK_MS)
  timer.unref?.()
}

export function stopStanding(): void {
  if (timer) clearInterval(timer)
  timer = null
}
