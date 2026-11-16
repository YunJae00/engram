import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { appendBotTurn, readBotTranscript, type VaultPaths } from 'core'
import type { ChatRequestDto } from '../src/shared/types.js'
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler: vi.fn(), handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn(), tapBroadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/task-notify.js', () => ({ taskQueued: vi.fn(), clientTaskQueued: vi.fn(), clearClientTaskQueues: vi.fn() }))
import { acknowledgeHanded, checkpointResume, readCheckpoint } from '../src/main/comet-checkpoint.js'

let paths: VaultPaths
beforeAll(async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  paths = { cache: await mkdtemp(join(temporary, 'midstream-followup-')) } as VaultPaths
})
afterAll(() => rm(paths.cache, { recursive: true, force: true }))

const deferred = () => { let open!: () => void; const done = new Promise<void>(resolve => { open = resolve }); return { done, open } }

// Mirrors the bot branch of sendChat: user row, engine, assistant row, acknowledge, then afterTurn.
async function harness() {
  const aside = await import('../src/main/aside-ipc.js')
  const follow = await import('../src/main/midstream-followup.js')
  const running = new Set<string>()
  const requests: string[] = []
  const glued: string[] = []
  const first = deferred()
  let steer: ((said: string[]) => boolean) | undefined
  const turn = async (request: ChatRequestDto): Promise<void> => {
    const channel = request.channel!, id = request.botId!
    if (running.has(channel)) throw new Error('busy')
    running.add(channel)
    try {
      if (!follow.savedFollowUp(channel, request.message)) await appendBotTurn(paths, id, { role: 'user', text: request.message, at: new Date().toISOString() })
      const stored = await readCheckpoint(paths, id)
      requests.push(request.message)
      if (requests.length === 1) {
        steer = said => { glued.push(...said.map(text => `Reply: ${text}`)); return true }
        await first.done
        steer = undefined
      }
      await appendBotTurn(paths, id, { role: 'assistant', text: [`Reply: ${request.message}`, ...glued].join(' '), at: new Date().toISOString() })
      await acknowledgeHanded(paths, id, stored.pending)
    } finally { running.delete(channel); follow.afterTurn(channel) }
  }
  const chat = follow.answerFollowUps(turn, channel => running.has(channel))
  aside.registerAsideIpc({ paths, busy: channel => running.has(channel) || follow.followingUp(channel), followUp: follow.followUpFor, setOffersAside: async () => {} })
  const say = (channel: string, text: string) => handlers.get('chat:say')!({}, channel, text)
  const idle = (channel: string) => vi.waitFor(() => { if (running.size || follow.followingUp(channel)) throw new Error('working') }, { timeout: 3000 })
  return { chat, say, idle, requests, glued, first, steerOffered: () => steer !== undefined, follow }
}
const rows = async (id: string) => (await readBotTranscript(paths, id)).map(turn => `${turn.role} ${turn.text}`)

it('follow-up gets its own reply when no tool step takes it', async () => {
  const h = await harness()
  const turn = h.chat({ engineId: '', botId: 'one', channel: 'bot-one', message: 'First', history: [] })
  await vi.waitFor(() => expect(h.requests).toEqual(['First']))
  await h.say('bot-one', 'And what is 3 times 7?')
  h.first.open()
  await turn
  await h.idle('bot-one')
  expect(h.requests).toEqual(['First', 'And what is 3 times 7?'])
  // grokbar c3: the host's one-line reply sits under the words; with no quick voice here it is the fixed line.
  expect(await rows('one')).toEqual(['user First', 'user And what is 3 times 7?', 'assistant Covering that too.', 'assistant Reply: First', 'assistant Reply: And what is 3 times 7?'])
})

it('live-steered follow-up is answered separately, not appended', async () => {
  const h = await harness()
  const turn = h.chat({ engineId: '', botId: 'two', channel: 'bot-two', message: 'First', history: [] })
  await vi.waitFor(() => expect(h.steerOffered()).toBe(true))
  await h.say('bot-two', 'What is the capital of France?')
  h.first.open()
  await turn
  await h.idle('bot-two')
  expect(h.glued).toEqual([])
  const all = await rows('two')
  expect(all.find(row => row.startsWith('assistant Reply: First'))).toBe('assistant Reply: First')
  expect(all.filter(row => row === 'assistant Reply: What is the capital of France?')).toHaveLength(1)
})

it('two follow-ups are both answered after the first answer', async () => {
  const h = await harness()
  const turn = h.chat({ engineId: '', botId: 'three', channel: 'bot-three', message: 'First', history: [] })
  await vi.waitFor(() => expect(h.requests).toEqual(['First']))
  await h.say('bot-three', 'One')
  await h.say('bot-three', 'Two')
  h.first.open()
  await turn
  await h.idle('bot-three')
  expect(h.requests).toEqual(['First', 'One', 'Two'])
  const all = await rows('three')
  for (const row of ['user One', 'user Two', 'assistant Reply: One', 'assistant Reply: Two']) expect(all.filter(r => r === row)).toHaveLength(1)
  expect((await readCheckpoint(paths, 'three')).pending).toEqual([])
})

it('a stopped turn answers nothing that was set to follow', async () => {
  const h = await harness()
  const turn = h.chat({ engineId: '', botId: 'four', channel: 'bot-four', message: 'First', history: [] })
  await vi.waitFor(() => expect(h.requests).toEqual(['First']))
  await h.say('bot-four', 'Said before Stop')
  const late = h.say('bot-four', 'Said as Stop lands')
  h.follow.dropFollowUps('bot-four')
  h.first.open()
  await turn
  await late
  await h.idle('bot-four')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(h.requests).toEqual(['First'])
})

it('an answered follow-up is not answered again after relaunch', async () => {
  const h = await harness()
  const turn = h.chat({ engineId: '', botId: 'five', channel: 'bot-five', message: 'First', history: [] })
  await vi.waitFor(() => expect(h.requests).toEqual(['First']))
  await h.say('bot-five', 'Follow')
  h.first.open()
  await turn
  await h.idle('bot-five')
  expect(h.requests).toEqual(['First', 'Follow'])
  const stored = await readCheckpoint(paths, 'five')
  expect(stored.pending).toEqual([])
  vi.resetModules()
  const relaunched = await harness()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(relaunched.requests).toEqual([])
  expect(checkpointResume(stored, await readBotTranscript(paths, 'five'))).not.toContain('User messages saved')
})

// grokbar T1/T2: words the running turn took with a tool result are answered inside it; they get no turn of their own.
it('gives the running turn the words said to it, wakes a lead waiting on its team, and starts no follow-up turn for them', async () => {
  const follow = await import('../src/main/midstream-followup.js')
  const ran: string[] = []
  let busy = true
  follow.answerFollowUps(async request => { ran.push(request.message) }, () => busy)
  const waiting = new AbortController(), given = new AbortController()
  let woke = 0, late = 0
  void follow.followUpSaid('bot-steer', waiting.signal).then(() => { woke++ })
  void follow.followUpSaid('bot-steer', given.signal).then(() => { late++ })
  given.abort()
  await Promise.resolve()
  expect(woke).toBe(0)
  follow.followUpFor('bot-steer')('아 대구도 추가해')
  await Promise.resolve()
  expect([woke, late]).toEqual([1, 0])
  // Words already waiting wake the next waiter at once.
  await follow.followUpSaid('bot-steer', new AbortController().signal)
  expect(follow.takeFollowUps('bot-steer')).toEqual(['아 대구도 추가해'])
  expect(follow.takeFollowUps('bot-steer')).toEqual([])
  busy = false
  follow.afterTurn('bot-steer')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(ran).toEqual([])
  // Words nobody took are still answered as their own turn.
  busy = true
  follow.followUpFor('bot-steer')('그리고 광주도')
  busy = false
  follow.afterTurn('bot-steer')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(ran).toEqual(['그리고 광주도'])
})
