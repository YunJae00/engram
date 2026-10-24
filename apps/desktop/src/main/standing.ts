import { dueNow, loadBots, markBotTaskRun, removeBotTask, scheduleOver, type TaskWatch, type VaultPaths } from 'core'

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
  // A kept request with no procedure: run as the first message of a new
  // conversation (or the next one in `into`), and brought to the person's
  // inbox when it is done.
  runPrompt?(name: string, goal: string, into?: string): Promise<{ ok: boolean; botId?: string }>
  // The listing a watched request looks at, one key per item (its id when it
  // has one); null while it cannot be read.
  peek?(watch: TaskWatch): Promise<{ key: string; id?: string }[] | null>
  now?(): Date
}

export async function standingTick(deps: StandingDeps): Promise<string[]> {
  const now = deps.now?.() ?? new Date()
  const started: string[] = []
  for (const bot of await loadBots(deps.paths)) {
    for (const task of bot.tasks ?? []) {
      if (!task.schedule) continue
      // A one-day request whose moment went by while the app was closed is
      // finished with, not kept forever.
      if (!task.routineId && scheduleOver(task.schedule, now)) { await removeBotTask(deps.paths, bot.id, task.id); continue }
      if (!dueNow(task.schedule, task.lastRunAt, now)) continue
      if (!task.routineId) {
        if (!deps.runPrompt) continue
        let message = task.goal
        let seen: string[] | undefined
        // Nothing new in the listing is nothing to say: no model call, no notice.
        if (task.watch) {
          const items = deps.peek ? await deps.peek(task.watch).catch(() => null) : null
          if (!items) continue
          seen = items.map(item => item.key)
          const fresh = task.seen ? items.filter(item => !task.seen!.includes(item.key)) : items
          if (!fresh.length) { await markBotTaskRun(deps.paths, bot.id, task.id, now, { seen }); continue }
          // Only counts and ids ride in the request; the items' own words are
          // read through the tool, where they arrive as data.
          const ids = fresh.flatMap(item => item.id ? [item.id] : [])
          message = `${task.goal}\n\n(${fresh.length} new in ${task.watch.tool} since the last look${ids.length ? `; ids: ${ids.join(', ')}` : ''})`
        }
        const reply = await deps.runPrompt(task.name, message, task.schedule.every ? task.chat : undefined)
        if (!reply.ok) continue
        if (task.schedule.on) await removeBotTask(deps.paths, bot.id, task.id)
        else await markBotTaskRun(deps.paths, bot.id, task.id, now, { ...(seen ? { seen } : {}), ...(task.schedule.every && reply.botId ? { chat: reply.botId } : {}) })
        started.push(task.id)
        return started
      }
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
