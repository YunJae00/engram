import { dueNow, loadBots, markBotTaskRun, removeBotTask, scheduleOver, type TaskWatch, type VaultPaths } from 'core'

export const STANDING_TICK_MS = 60_000

interface StandingDeps {
  paths: VaultPaths
  runRoutine(id: string): Promise<{ ok: boolean; blocked?: boolean }>
  runPrompt?(name: string, goal: string, into?: string): Promise<{ ok: boolean; botId?: string }>
  peek?(watch: TaskWatch): Promise<{ key: string; id?: string }[] | null>
  now?(): Date
}

export async function standingTick(deps: StandingDeps): Promise<string[]> {
  const now = deps.now?.() ?? new Date()
  const started: string[] = []
  for (const bot of await loadBots(deps.paths)) {
    for (const task of bot.tasks ?? []) {
      if (!task.schedule) continue
      if (task.paused === true) continue
      if (!task.routineId && scheduleOver(task.schedule, now)) { await removeBotTask(deps.paths, bot.id, task.id); continue }
      if (!dueNow(task.schedule, task.lastRunAt, now)) continue
      if (!task.routineId) {
        if (!deps.runPrompt) continue
        let message = task.goal
        let seen: string[] | undefined
        if (task.watch) {
          const items = deps.peek ? await deps.peek(task.watch).catch(() => null) : null
          if (!items) continue
          seen = items.map(item => item.key)
          const fresh = task.seen ? items.filter(item => !task.seen!.includes(item.key)) : items
          if (!fresh.length) { await markBotTaskRun(deps.paths, bot.id, task.id, now, { seen }); continue }
          const ids = fresh.flatMap(item => item.id ? [item.id] : [])
          message = `${task.goal}\n\n(${fresh.length} new in ${task.watch.tool} since the last look${ids.length ? `; ids: ${ids.join(', ')}` : ''})`
        }
        const reply = await deps.runPrompt(task.name, message, task.schedule.every || task.chat === bot.id ? task.chat : undefined)
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
      return started
    }
  }
  return started
}

let timer: NodeJS.Timeout | null = null

export function startStanding(deps: StandingDeps, intervalMs = STANDING_TICK_MS): void {
  stopStanding()
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    void standingTick(deps).catch(() => undefined).finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
}

export function stopStanding(): void {
  if (timer) clearInterval(timer)
  timer = null
}
