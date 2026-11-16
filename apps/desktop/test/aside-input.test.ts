import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { appendBotTurn, readBotTranscript, type VaultPaths } from 'core'
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler: vi.fn(), handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn(), tapBroadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/task-notify.js', () => ({ taskQueued: vi.fn(), clientTaskQueued: vi.fn(), clearClientTaskQueues: vi.fn() }))
import { registerAsideIpc } from '../src/main/aside-ipc.js'
import { turnGoals } from '../src/main/turn-state.js'
import { tapBroadcast } from '../src/main/engine-health.js'
import type { EngramEvent } from '../src/shared/types.js'
import { acknowledgeHanded, readCheckpoint } from '../src/main/comet-checkpoint.js'

it('hands a message said as the turn completes to the follow-up queue once', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-input-'))
  const paths = { cache } as VaultPaths
  let calls = 0
  const held: string[] = []
  registerAsideIpc({ paths, busy: () => ++calls === 1, followUp: () => text => held.push(text), setOffersAside: async () => {} })
  expect(handlers.has('chat:steer')).toBe(false)
  try {
    expect(await handlers.get('chat:say')!({}, 'bot-late', 'Do not submit')).toEqual({ ok: true, action: 'relay', instruction: 'Do not submit' })
    expect(held).toEqual(['Do not submit'])
    expect((await readBotTranscript(paths, 'late')).map(turn => turn.text)).toEqual(['Do not submit'])
    const next = await readCheckpoint(paths, 'late')
    expect(next.pending).toEqual(['Do not submit'])
    await acknowledgeHanded(paths, 'late', next.pending)
    expect((await readCheckpoint(paths, 'late')).pending).toEqual([])
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('migrates an old returned instruction into pending input exactly once', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-migration-'))
  const paths = { cache } as VaultPaths
  try {
    await mkdir(join(cache, 'checkpoints'))
    await writeFile(join(cache, 'checkpoints/one.json'), JSON.stringify({ pending: [], returned: ['Only read'], replayed: ['Old instruction'] }))
    expect((await readCheckpoint(paths, 'one')).pending).toEqual(['Only read'])
    await acknowledgeHanded(paths, 'one', ['Only read'])
    expect((await readCheckpoint(paths, 'one')).pending).toEqual([])
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('acknowledges a persisted user row even when checkpoint storage fails afterward', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-write-failure-'))
  const paths = { cache } as VaultPaths
  const checkpoint = await import('../src/main/comet-checkpoint.js')
  const change = vi.spyOn(checkpoint, 'changeCheckpoint').mockRejectedValueOnce(new Error('disk unavailable'))
  registerAsideIpc({ paths, busy: () => true, followUp: () => () => {}, setOffersAside: async () => {} })
  try {
    await expect(handlers.get('chat:say')!({}, 'bot-persisted', 'Only Claude Desktop')).resolves.toMatchObject({ ok: true })
    expect((await readBotTranscript(paths, 'persisted')).map(turn => turn.text)).toEqual(['Only Claude Desktop'])
  } finally { change.mockRestore(); await rm(cache, { recursive: true, force: true }) }
})

// qa146 S26: "…기억해 둘게요." then the memory write is a finished answer; words said then are the next turn.
it('relays words said while the answer streams, and refuses them once the answer is done', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-done-'))
  const paths = { cache } as VaultPaths
  const held: string[] = []
  let answered = false
  registerAsideIpc({ paths, busy: () => true, answered: () => answered, followUp: () => text => held.push(text), setOffersAside: async () => {} })
  const event = vi.mocked(tapBroadcast).mock.calls.at(-1)![0] as (event: EngramEvent) => void
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-done', text) as Promise<{ ok: boolean }>
  try {
    event({ type: 'comet:working', channel: 'bot-done', working: true })
    event({ type: 'comet:step', channel: 'bot-done', line: 'keep_in_mind: saved before any words' })
    event({ type: 'chat:token', channel: 'bot-done', text: 'I will remember that.' })
    expect((await say('While it streams')).ok).toBe(true)
    // The tool-use start closes the bubble and names the memory tool, before its step.
    event({ type: 'chat:token', channel: 'bot-done', text: '', reset: true, tool: 'mcp__engram__keep_in_mind' })
    expect((await say('Before the memory step')).ok).toBe(false)
    event({ type: 'comet:step', channel: 'bot-done', line: 'keep_in_mind: launch is Dec 5' })
    expect((await say('After the short answer')).ok).toBe(false)
    event({ type: 'comet:working', channel: 'bot-done', working: false })
    event({ type: 'comet:working', channel: 'bot-done', working: true })
    event({ type: 'chat:token', channel: 'bot-done', text: 'A long essay' })
    event({ type: 'chat:token', channel: 'bot-done', text: '', reset: true, tool: 'Read' })
    expect((await say('At a work tool start')).ok).toBe(true)
    event({ type: 'comet:step', channel: 'bot-done', line: 'search_web: essay facts' })
    expect((await say('Next turn, still writing')).ok).toBe(true)
    answered = true
    expect((await say('After the answer landed')).ok).toBe(false)
    expect(held).toEqual(['While it streams', 'At a work tool start', 'Next turn, still writing'])
    expect((await readBotTranscript(paths, 'done')).filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual(['While it streams', 'At a work tool start', 'Next turn, still writing'])
  } finally { await rm(cache, { recursive: true, force: true }) }
})

// grokbar T3: "멈춰" typed while a team works stopped nothing; it waited behind the turn and was answered as its own turn.
it('stops the conversation at once when the whole message is a stop word, and leaves any other message to the turn', async () => {
  const { STOP_WORDS } = await import('../src/main/aside-ipc.js')
  for (const word of ['멈춰', '멈춰!', ' 그만해 ', '중지해줘', '취소', 'stop', 'Stop.', 'cancel']) expect(STOP_WORDS.test(word), word).toBe(true)
  for (const word of ['멈춰 있는 창 닫아줘', '그만큼만 정리해', '주가 조사 말고 환율로 해', 'stop words 목록 알려줘', '아 대구도 추가해', '취소 수수료 알려줘']) expect(STOP_WORDS.test(word), word).toBe(false)
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-stop-'))
  const paths = { cache } as VaultPaths
  const stopped: [string, string][] = [], held: string[] = []
  let busy = true
  registerAsideIpc({ paths, busy: () => busy, answered: () => true, followUp: () => text => held.push(text), setOffersAside: async () => {}, stop: async (channel, said) => { stopped.push([channel, said]) } })
  try {
    // Also after the answer is out, while the team or a check still runs.
    expect(await handlers.get('chat:say')!({}, 'bot-team', '멈춰')).toEqual({ ok: true, action: 'stop', reply: '중지했어요.' })
    // grokbar review r1: the reply is in the thread's language, not the stop word's.
    expect(await handlers.get('chat:say')!({}, 'bot-team', 'stop')).toEqual({ ok: true, action: 'stop', reply: '중지했어요.' })
    await appendBotTurn(paths, 'en', { role: 'user', text: 'Compare the three phones', at: new Date().toISOString() })
    expect(await handlers.get('chat:say')!({}, 'bot-en', 'stop')).toEqual({ ok: true, action: 'stop', reply: 'Stopped.' })
    turnGoals.set('bot-fresh', '아이폰 18 가격 조사해줘')
    expect(await handlers.get('chat:say')!({}, 'bot-fresh', 'Cancel')).toEqual({ ok: true, action: 'stop', reply: '중지했어요.' })
    turnGoals.delete('bot-fresh')
    // The answer is back before the stop runs: nothing was stopped yet when it returned.
    expect(stopped).toEqual([['bot-team', '중지했어요.'], ['bot-team', '중지했어요.'], ['bot-en', 'Stopped.']])
    await new Promise(done => setImmediate(done))
    expect(stopped).toEqual([['bot-team', '중지했어요.'], ['bot-team', '중지했어요.'], ['bot-en', 'Stopped.'], ['bot-fresh', '중지했어요.']])
    expect(held).toEqual([])
    expect((await readBotTranscript(paths, 'team')).map(turn => [turn.role, turn.text, turn.aside])).toEqual([['user', '멈춰', true], ['user', 'stop', true]])
    expect((await readCheckpoint(paths, 'team')).pending).toEqual([])
    // Nothing is running: the word is an ordinary message for the next turn.
    busy = false
    expect(await handlers.get('chat:say')!({}, 'bot-team', '멈춰')).toEqual({ ok: false })
    expect(stopped).toHaveLength(4)
  } finally { await rm(cache, { recursive: true, force: true }) }
})
