import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { addRoutine, appendBotTurn, createBot, initVault, loadBots, markRoutineRun, readBotTranscript, type RoutineRunResult } from 'core'
import { describe, expect, it } from 'vitest'
import type { EngramEvent } from '../src/shared/types.js'
import { routineRecovery, startRoutineChat } from '../src/main/routine-chat.js'

async function vault() {
  const dir = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(dir, { recursive: true })
  return initVault(await mkdtemp(join(dir, 'routine-chat-')), { git: false })
}

describe('manual routine chats', () => {
  it('starts a saved task in a fresh chat with its browser context instead of partial replay', async () => {
    const paths = await vault()
    const saved = await addRoutine(paths, { name: 'Read details', steps: [], task: { goal: 'Read every detail and verify the table', urls: ['https://portal.example/reports'], method: ['press: Details', 'read_open_page'], surface: 'web' } })
    const events: EngramEvent[] = []
    let released = false
    let replayed = false
    let active = false
    let complete!: (ok: boolean) => void
    const done = new Promise<boolean>(resolve => { complete = resolve })
    const result = await startRoutineChat(paths, saved.id, {}, {
      claim: () => () => { released = true },
      broadcast: event => { events.push(event) },
      active: (_channel, running) => { active = running },
      begin: async () => { replayed = true; return { ok: false } },
      recover: (botId, message, context, routine) => {
        expect(botId).toBe(events.find(event => event.type === 'routine:chat')?.botId)
        expect(message).toBe(saved.task!.goal)
        expect(context).toContain('https://portal.example/reports')
        expect(context).toContain('not desktop mouse/keyboard')
        expect(routine?.task?.surface).toBe('web')
        return done
      },
    })
    expect(result.ok).toBe(true)
    expect(replayed).toBe(false)
    expect(released).toBe(false)
    expect(active).toBe(true)
    expect(await readBotTranscript(paths, result.botId!)).toHaveLength(1)
    complete(true)
    await expect.poll(() => released).toBe(true)
    expect(active).toBe(false)
    expect(events.filter(event => event.type === 'chat:done')).toHaveLength(0)
    await markRoutineRun(paths, saved.id, 'done', new Date(), true)
    let invoked = false
    const blocked = await startRoutineChat(paths, saved.id, {}, {
      claim: () => () => { released = true },
      broadcast: event => { events.push(event) },
      active: (_channel, running) => { active = running },
      begin: async () => { invoked = true; return { ok: false } },
      recover: async () => { invoked = true; return true },
    })
    expect(blocked.blocked).toBe('already-ran-today')
    expect(invoked).toBe(false)
    expect(active).toBe(false)
  })
  it('hands an untouched missing target to the same chat once, without duplicating its user message', async () => {
    const paths = await vault()
    const routine = await addRoutine(paths, { name: 'Read notices', steps: [{ kind: 'open', url: 'https://example.com' }, { kind: 'click', target: { text: 'Notices' } }, { kind: 'read' }] })
    const events: EngramEvent[] = []
    let recoveries = 0
    const reply = await startRoutineChat(paths, routine.id, {}, {
      claim: () => () => undefined,
      active: () => undefined,
      broadcast: event => { events.push(event) },
      begin: async () => ({ ok: true, done: Promise.resolve({ ok: false, readings: [], error: 'missing target', resumeFrom: 1 }) }),
      recover: async (botId, message, context) => {
        recoveries++
        expect((await readBotTranscript(paths, botId)).map(turn => turn.text)).toEqual([message])
        expect(context).toContain('"completedSteps":1')
        expect(context).not.toContain('"kind":"open"')
        expect(context).toContain('Read or look first')
        await appendBotTurn(paths, botId, { role: 'assistant', text: 'Verified notices.', at: new Date().toISOString() })
        return true
      },
    })
    await expect.poll(async () => (await readBotTranscript(paths, reply.botId!)).length).toBe(2)
    expect(recoveries).toBe(1)
    expect(events.filter(event => event.type === 'chat:done')).toHaveLength(0)
    for (const result of [{ ok: false, error: 'canceled', readings: [] }, { ok: false, blocked: 'unfinished-write' as const, readings: [], resumeFrom: 1 }, { ok: false, readings: [], resumeFrom: 99 }]) {
      expect(routineRecovery(routine, result)).toBeNull()
    }
  })
  it('creates one fresh chat before work, preserves the old chat, and persists actual readings', async () => {
    const paths = await vault()
    const owner = await createBot(paths, { name: 'Existing chat' })
    await appendBotTurn(paths, owner.id, { role: 'user', text: 'Earlier work.', at: new Date().toISOString() })
    const routine = await addRoutine(paths, { name: 'Notices', steps: [{ kind: 'open', url: 'https://example.com' }, { kind: 'read' }] })
    const events: EngramEvent[] = []
    const active = new Set<string>()
    let finish!: (result: RoutineRunResult) => void
    const done = new Promise<RoutineRunResult>((resolve) => { finish = resolve })
    let starts = 0
    const deps = {
      claim: () => () => undefined,
      broadcast: (event: EngramEvent) => { events.push(event) },
      active: (channel: string, running: boolean) => { if (running) active.add(channel); else active.delete(channel) },
      begin: async (_id: string, options: { lane?: string }) => {
        starts++
        const opened = events.find((event) => event.type === 'routine:chat')!
        expect(opened.type).toBe('routine:chat')
        if (opened.type !== 'routine:chat') throw new Error('chat must exist before replay')
        expect(options.lane).toBe(`bot-${opened.botId}`)
        expect(active.has(options.lane!)).toBe(true)
        expect((await readBotTranscript(paths, opened.botId)).map((turn) => turn.text)).toEqual(['Run Notices.'])
        return { ok: true, done }
      },
    }
    const first = startRoutineChat(paths, routine.id, {}, deps)
    const duplicate = startRoutineChat(paths, routine.id, {}, deps)
    expect(duplicate).toBe(first)
    const refused = await startRoutineChat(paths, 'another-routine', {}, deps)
    expect(refused).toMatchObject({ ok: false })
    expect(refused.botId).toBeUndefined()
    const reply = await first
    expect(reply.botId).not.toBe(owner.id)
    expect(starts).toBe(1)
    expect(await loadBots(paths)).toHaveLength(2)
    finish({ ok: true, readings: [{ url: 'https://example.com', title: 'Notices', text: 'The office closes Friday.\n## Page heading' }], cardId: 'card-1' })
    await expect.poll(() => events.filter((event) => event.type === 'chat:done').length).toBe(1)
    const transcript = await readBotTranscript(paths, reply.botId!)
    expect(transcript).toHaveLength(2)
    expect(transcript[1]?.text).toContain('> The office closes Friday.\n> ## Page heading')
    expect(transcript[1]?.text).toContain('Review')
    expect(active.size).toBe(0)
    expect((await readBotTranscript(paths, owner.id)).map((turn) => turn.text)).toEqual(['Earlier work.'])
  })

  it('puts a guarded retry in its new chat and passes explicit approval and slots to a fresh retry', async () => {
    const paths = await vault()
    const routine = await addRoutine(paths, { name: 'Daily entry', steps: [{ kind: 'open', url: 'https://example.com' }] })
    const events: EngramEvent[] = []
    const optionsSeen: { force?: boolean; slots?: Record<string, string> }[] = []
    const deps = {
      claim: () => () => undefined,
      broadcast: (event: EngramEvent) => { events.push(event) },
      active: () => undefined,
      begin: async (_id: string, options: { force?: boolean; slots?: Record<string, string> }) => {
        optionsSeen.push(options)
        return { ok: false, blocked: 'unfinished-write' as const }
      },
    }
    const first = await startRoutineChat(paths, routine.id, { slots: { entry: 'A note' } }, deps)
    const completed = events.find((event) => event.type === 'chat:done')!
    expect(completed).toMatchObject({ type: 'chat:done', offer: { kind: 'run', force: true, routineId: routine.id, slots: { entry: 'A note' } } })
    expect((await readBotTranscript(paths, first.botId!))[1]?.text).toContain('Check the website')
    const second = await startRoutineChat(paths, routine.id, { force: true, slots: { entry: 'A note' } }, deps)
    expect(second.botId).not.toBe(first.botId)
    expect(optionsSeen[1]).toMatchObject({ force: true, slots: { entry: 'A note' } })
  })
})
