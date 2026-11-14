import { randomUUID } from 'node:crypto'
import { changeNotices, listTasks, loadBots, readBotTranscript, readNotices, type DelegatedTask, type NoticeItem, type VaultPaths } from 'core'
import { flog } from './flog.js'
import { closingLang, type ClosingLang } from './task-closing.js'

// Coming back after a while away gets one bell item saying, per bot, what
// finished, what waits for the person and what is still going. Names and counts only.

export const AWAY_MS = 10 * 60_000
type Said = readonly { role: string; text: string }[]
export interface AwayRow { botId: string; name: string; finished: number; waiting: number; running: number; stopped?: number }
export interface AwayIo {
  tasks(): Promise<DelegatedTask[]>
  bots(): Promise<{ id: string; name: string }[]>
  notices(): Promise<NoticeItem[]>
  said(botId: string): Promise<Said>
  post(item: NoticeItem): Promise<unknown>
}

let since: number | undefined
let report: ((from: number, to: number) => Promise<void>) | undefined
export function mainFocus(focused: boolean, now = Date.now()): void {
  if (!focused) { since ??= now; return }
  const from = since
  since = undefined
  if (from !== undefined && now - from >= AWAY_MS && report) void report(from, now).catch(error => flog('away', error))
}

const movedAt = (task: DelegatedTask): number => Date.parse(task.state === 'done' || task.state === 'failed' ? task.finishedAt ?? task.updatedAt : task.updatedAt)

// A scheduled run already has its own bell item. Its task is the first one its bot started inside that run's
// time; other work on the same bot, started before or alongside it, still belongs in the summary.
export function scheduledRun(task: DelegatedTask, notices: readonly NoticeItem[], tasks: readonly DelegatedTask[] = [task]): boolean {
  return notices.some(n => {
    if (n.kind !== 'scheduled' || n.botId !== task.botId) return false
    const began = Date.parse(n.began ?? n.at), ended = n.running === true ? Infinity : Date.parse(n.at)
    const inside = (one: DelegatedTask): boolean => { const at = Date.parse(one.createdAt); return one.botId === task.botId && at >= began && at <= ended }
    const first = tasks.filter(inside).reduce<DelegatedTask | undefined>((a, b) => !a || Date.parse(b.createdAt) < Date.parse(a.createdAt) ? b : a, undefined)
    return first?.id === task.id
  })
}

// Only what moved between leaving and coming back counts; a change after the return was seen live.
export function awayChanges(tasks: readonly DelegatedTask[], bots: readonly { id: string; name: string }[], from: number, to = Infinity): { rows: AwayRow[]; botId: string; newest: DelegatedTask } | undefined {
  const rows = new Map<string, AwayRow>(bots.map(bot => [bot.id, { botId: bot.id, name: bot.name, finished: 0, waiting: 0, running: 0, stopped: 0 }]))
  let newest: DelegatedTask | undefined
  for (const task of tasks) {
    const row = rows.get(task.botId)
    if (!row) continue
    const moved = movedAt(task) >= from && movedAt(task) <= to
    if (task.state === 'running' || task.state === 'queued') row.running++
    else if (!moved) continue
    else if (task.state === 'done') row.finished++
    else if (task.state === 'stopped') row.stopped = (row.stopped ?? 0) + 1
    else row.waiting++
    if (moved && (!newest || movedAt(task) > movedAt(newest))) newest = task
  }
  if (!newest) return undefined
  const shown = [...rows.values()].filter(row => row.finished + row.waiting + row.running + (row.stopped ?? 0) > 0)
  const botId = (shown.find(row => row.waiting) ?? shown.find(row => row.finished) ?? shown[0]!).botId
  return { rows: shown, botId, newest }
}

const MAX_BOTS = 5
export function awayText(rows: readonly AwayRow[], lang: ClosingLang): { title: string; text: string } {
  const ko = lang === 'ko'
  const line = (row: AwayRow): string => {
    const parts = ko
      ? [row.finished && `끝남 ${row.finished}`, row.waiting && `답 기다림 ${row.waiting}`, row.running && `진행 중 ${row.running}`, row.stopped && `멈춤 ${row.stopped}`]
      : [row.finished && `${row.finished} finished`, row.waiting && `${row.waiting} waiting for you`, row.running && `${row.running} still running`, row.stopped && `${row.stopped} stopped`]
    return `${row.name.replace(/\s+/g, ' ').trim().slice(0, 40)}: ${parts.filter(Boolean).join(', ')}`
  }
  const more = rows.length - MAX_BOTS
  const text = rows.slice(0, MAX_BOTS).map(line).join(' · ') + (more > 0 ? ko ? ` 외 ${more}개` : ` and ${more} more` : '')
  return { title: ko ? '자리를 비운 동안' : 'While you were away', text }
}

export const vaultIo = (paths: VaultPaths): AwayIo => ({
  tasks: () => listTasks(paths), bots: () => loadBots(paths), notices: () => readNotices(paths),
  said: botId => readBotTranscript(paths, botId, 40),
  // An unread summary is replaced, not stacked.
  post: item => changeNotices(paths, items => [item, ...items.filter(one => one.key !== 'away' || one.read)]),
})

export function awayReady(io: AwayIo, changed: () => void): void {
  report = async (from, to) => {
    const [tasks, bots, notices] = await Promise.all([io.tasks(), io.bots(), io.notices()])
    const found = awayChanges(tasks.filter(task => !scheduledRun(task, notices, tasks)), bots, from, to)
    if (!found) return
    const { title, text } = awayText(found.rows, closingLang(await io.said(found.newest.botId).catch(() => []), found.newest.goal))
    await io.post({ id: randomUUID(), kind: 'system', key: 'away', title, text, botId: found.botId, at: new Date().toISOString(), read: false })
    changed()
  }
}
