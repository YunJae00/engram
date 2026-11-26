import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { appendBotTurn, readBotTranscript, type VaultPaths } from 'core'
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

async function harness() {
  const aside = await import('../src/main/aside-ipc.js')
  const follow = await import('../src/main/midstream-followup.js')
  const running = new Set<string>()
  const turns: string[] = []
  const step = deferred()
  const turn = async (id: string, message: string, steps = 1): Promise<void> => {
    const channel = `bot-${id}`
    running.add(channel)
    follow.openFollowUps(channel)
    turns.push(message)
    try {
      await appendBotTurn(paths, id, { role: 'user', text: message, at: new Date().toISOString() })
      const read: string[] = []
      await step.done
      for (let i = 0; i < steps; i++) {
        const quiet = new AbortController()
        await Promise.race([follow.followUpSaid(channel, quiet.signal), new Promise(resolve => setTimeout(resolve, 50))]).finally(() => quiet.abort())
        read.push(...follow.takeFollowUps(channel))
      }
      const stored = await readCheckpoint(paths, id)
      await appendBotTurn(paths, id, { role: 'assistant', text: [message, ...read].join(' + '), at: new Date().toISOString() })
      await acknowledgeHanded(paths, id, stored.pending)
    } finally { running.delete(channel); follow.closeFollowUps(channel) }
  }
  aside.registerAsideIpc({ paths, busy: channel => running.has(channel), reading: follow.readingFollowUps, followUp: follow.followUp, setOffersAside: async () => {}, stop: async channel => follow.dropFollowUps(channel) })
  const say = (channel: string, text: string) => handlers.get('chat:say')!({}, channel, text) as Promise<{ ok: boolean; action?: string }>
  return { turn, say, turns, step, follow }
}
const rows = async (id: string) => (await readBotTranscript(paths, id)).map(turn => `${turn.role} ${turn.text}`)

it('lands a message said during the turn in that turn\'s one result and runs no second turn', async () => {
  const h = await harness()
  const turn = h.turn('one', '목포 바다 앞 숙소 찾아줘')
  const said = h.say('bot-one', '주차 되는 곳이면 좋겠어요')
  h.step.open()
  expect(await said).toEqual({ ok: true })
  await turn
  expect(h.turns).toEqual(['목포 바다 앞 숙소 찾아줘'])
  expect(await rows('one')).toEqual(['user 목포 바다 앞 숙소 찾아줘', 'user 주차 되는 곳이면 좋겠어요', 'assistant 목포 바다 앞 숙소 찾아줘 + 주차 되는 곳이면 좋겠어요'])
})

it('lands two messages said during the turn in the same one result', async () => {
  const h = await harness()
  const turn = h.turn('two', '청주 공항 주차 요금 알아봐', 2)
  const first = h.say('bot-two', '장기 주차 기준으로요')
  const second = h.say('bot-two', '사흘 세워 둘 거예요')
  h.step.open()
  expect([await first, await second]).toEqual([{ ok: true }, { ok: true }])
  await turn
  expect(h.turns).toEqual(['청주 공항 주차 요금 알아봐'])
  const all = await rows('two')
  expect(all.filter(row => row.startsWith('assistant'))).toEqual(['assistant 청주 공항 주차 요금 알아봐 + 장기 주차 기준으로요 + 사흘 세워 둘 거예요'])
  expect((await readCheckpoint(paths, 'two')).pending).toEqual([])
})

it('hands a message the lead never read back to the sender once the lead is done, stored once, so it goes out as the next message', async () => {
  const h = await harness()
  const turn = h.turn('three', '안동 하회마을 입장료 알려줘', 0)
  const late = h.say('bot-three', '어른 둘이에요')
  await new Promise(resolve => setTimeout(resolve, 5))
  h.step.open()
  expect(await late).toEqual({ ok: false })
  await turn
  expect(h.follow.storedUnread('bot-three', '어른 둘이에요')).toBe(true)
  expect(h.follow.storedUnread('bot-three', '어른 둘이에요')).toBe(false)
  expect(await h.say('bot-three', '아이도 하나 있어요')).toEqual({ ok: false })
  expect(h.follow.storedUnread('bot-three', '아이도 하나 있어요')).toBe(false)
  expect(h.turns).toEqual(['안동 하회마을 입장료 알려줘'])
  expect(await rows('three')).toEqual(['user 안동 하회마을 입장료 알려줘', 'user 어른 둘이에요', 'assistant 안동 하회마을 입장료 알려줘'])
})

it('drops a waiting message when a stop word lands, so the stopped lead never reads it', async () => {
  const h = await harness()
  const turn = h.turn('four', '통영 케이블카 운행 시간 봐줘')
  const waiting = h.say('bot-four', '주말 기준으로요')
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(await h.say('bot-four', '그만')).toMatchObject({ ok: true, action: 'stop' })
  expect(await waiting).toEqual({ ok: true })
  h.step.open()
  await turn
  expect(await rows('four')).toEqual(['user 통영 케이블카 운행 시간 봐줘', 'user 주말 기준으로요', 'user 그만', 'assistant 통영 케이블카 운행 시간 봐줘'])
})

it('leaves nothing to answer again after relaunch once the turn read the message', async () => {
  const h = await harness()
  const turn = h.turn('five', '속초 중앙시장 주차장 있어?')
  const said = h.say('bot-five', '오후 늦게 갈 거예요')
  h.step.open()
  await said
  await turn
  const stored = await readCheckpoint(paths, 'five')
  expect(stored.pending).toEqual([])
  expect(checkpointResume(stored, await readBotTranscript(paths, 'five'))).not.toContain('User messages saved')
})

it('wakes a lead waiting for words said to it and gives them to it once', async () => {
  const follow = await import('../src/main/midstream-followup.js')
  follow.openFollowUps('bot-steer')
  const waiting = new AbortController(), given = new AbortController()
  let woke = 0, late = 0
  void follow.followUpSaid('bot-steer', waiting.signal).then(() => { woke++ })
  void follow.followUpSaid('bot-steer', given.signal).then(() => { late++ })
  given.abort()
  await Promise.resolve()
  expect(woke).toBe(0)
  const read = follow.followUp('bot-steer', '여수 쪽도 같이 봐 줘')
  await Promise.resolve()
  expect([woke, late]).toEqual([1, 0])
  expect(follow.takeFollowUps('bot-steer')).toEqual(['여수 쪽도 같이 봐 줘'])
  expect(follow.takeFollowUps('bot-steer')).toEqual([])
  expect(await read).toBe(true)
  follow.closeFollowUps('bot-steer')
  expect(await follow.followUp('bot-steer', '순천도요')).toBe(false)
})
