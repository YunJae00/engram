import { ipcMain } from 'electron'
import { changeNotices, loadBots, readNotices, removeBotTask, scheduleWords, type NoticeItem, type VaultPaths } from 'core'
import type { NoticesDto, ScheduledDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import type { VaultContext } from './vault.js'
import { openHabit } from './habits-ipc.js'

// The bell: what Engram brought on its own, and what is set to run later.

export async function scheduledTasks(paths: VaultPaths): Promise<ScheduledDto[]> {
  return (await loadBots(paths)).flatMap(bot => (bot.tasks ?? [])
    .filter(task => task.schedule && !task.routineId)
    .map(task => ({ id: task.id, botId: bot.id, name: task.name, goal: task.goal, when: scheduleWords(task.schedule!), ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}) })))
}

export async function removeScheduled(paths: VaultPaths, id: string): Promise<boolean> {
  const task = (await scheduledTasks(paths)).find(one => one.id === id)
  if (!task) return false
  await removeBotTask(paths, task.botId, id)
  broadcast({ type: 'bots:changed' })
  broadcast({ type: 'notices:changed' })
  return true
}

const dto = (item: NoticeItem): NoticesDto['items'][number] => ({ id: item.id, kind: item.kind, title: item.title, text: item.text, at: item.at, read: item.read, running: item.running === true })

export function registerNoticesIpc(ctx: VaultContext): void {
  const list = async (): Promise<NoticesDto> => ({ items: (await readNotices(ctx.paths)).map(dto), scheduled: await scheduledTasks(ctx.paths) })
  ipcMain.handle('notices:list', list)
  // Opening an item reads it and gives the conversation to show.
  ipcMain.handle('notices:open', async (_event, id: unknown): Promise<string> => {
    const item = (await readNotices(ctx.paths)).find(one => one.id === id)
    if (!item) throw new Error('That notification is gone.')
    const botId = item.botId ?? (item.kind === 'habit' && item.key ? await openHabit(ctx, item.key, item.text) : undefined)
    if (!botId) throw new Error('That notification has no conversation.')
    await changeNotices(ctx.paths, items => items.map(one => one.id === item.id ? { ...one, read: true, botId } : one))
    broadcast({ type: 'notices:changed' })
    return botId
  })
  ipcMain.handle('notices:clear', async () => {
    await changeNotices(ctx.paths, items => items.filter(item => !item.read))
    broadcast({ type: 'notices:changed' })
    return list()
  })
  ipcMain.handle('notices:unschedule', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !await removeScheduled(ctx.paths, id)) throw new Error('That schedule is gone.')
    return list()
  })
}
