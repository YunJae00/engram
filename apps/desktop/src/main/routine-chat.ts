import { appendBotTurn, createBot, listRoutines, type RoutineBlock, type RoutineRunResult, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'

export type RoutineRunReply = { ok: boolean; error?: string; blocked?: RoutineBlock; botId?: string }
export type RoutineStartOptions = { force?: boolean; slots?: Record<string, string>; lane?: string; manual?: boolean }

const pending = new Map<string, { id: string; work: Promise<RoutineRunReply> }>()

function resultText(name: string, result: RoutineRunResult): string {
  const outcome = result.ok ? `Finished ${name}.` : `Stopped ${name}: ${result.error ?? 'the routine could not finish'}.`
  const readings = result.readings.map((reading) => {
    const quoted = reading.text.slice(0, 12_000).split('\n').map((line) => `> ${line}`).join('\n')
    return `${reading.title || reading.url}\n\nSource: ${reading.url}\n\n${quoted}`
  })
  return [outcome, ...readings, ...(result.cardId ? ['The collected pages are also waiting in Review.'] : [])].join('\n\n')
}

export function startRoutineChat(
  paths: VaultPaths,
  id: string,
  options: RoutineStartOptions,
  deps: {
    begin(id: string, options: RoutineStartOptions): Promise<RoutineRunReply & { done?: Promise<RoutineRunResult> }>
    broadcast(event: EngramEvent): void
    active(channel: string, running: boolean): void
    claim(): (() => void) | null
  },
): Promise<RoutineRunReply> {
  const key = paths.cache
  const busy = { ok: false, error: 'A routine or errand is already running. Try again when it finishes.' }
  const existing = pending.get(key)
  if (existing) return existing.id === id ? existing.work : Promise.resolve(busy)
  const release = deps.claim()
  if (!release) return Promise.resolve(busy)
  const clear = () => { pending.delete(key); release() }
  const start = async (): Promise<RoutineRunReply> => {
    const saved = (await listRoutines(paths)).find((routine) => routine.id === id)
    if (!saved) return { ok: false, error: 'That routine no longer exists.' }
    const bot = await createBot(paths, { name: saved.name })
    const channel = `bot-${bot.id}`
    const message = `Run ${saved.name}.`
    await appendBotTurn(paths, bot.id, { role: 'user', text: message, at: new Date().toISOString() })
    deps.active(channel, true)
    deps.broadcast({ type: 'bots:changed' })
    deps.broadcast({ type: 'routine:chat', botId: bot.id, routineId: id, name: saved.name, message })
    const finish = async (text: string, offer?: Extract<EngramEvent, { type: 'chat:done' }>['offer']) => {
      await appendBotTurn(paths, bot.id, { role: 'assistant', text, at: new Date().toISOString() })
      deps.active(channel, false)
      deps.broadcast({ type: 'chat:done', channel, text, ...(offer ? { offer } : {}) })
    }
    const fail = (error: unknown) => {
      deps.active(channel, false)
      deps.broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) })
    }
    try {
      const { done, ...reply } = await deps.begin(id, { ...options, lane: channel, manual: true })
      if (done) {
        void done.then((result) => finish(resultText(saved.name, result))).catch(fail).finally(clear)
      } else {
        const text = reply.blocked === 'already-ran-today'
          ? `${saved.name} already ran today and can post to a website. Run it again only if you want another submission.`
          : reply.blocked === 'unfinished-write'
            ? `${saved.name} stopped during its last submission. Check the website before running it again.`
            : reply.error ?? 'The routine could not start.'
        await finish(text, reply.blocked ? { kind: 'run', routineId: id, name: saved.name, force: true, ...(options.slots ? { slots: options.slots } : {}) } : undefined)
        clear()
      }
      return { ...reply, botId: bot.id }
    } catch (error) {
      fail(error)
      throw error
    }
  }
  const work = start().then((reply) => {
    if (!reply.botId) clear()
    return reply
  }).catch((error) => { clear(); throw error })
  pending.set(key, { id, work })
  return work
}
