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
    // grokbar c3: the host answers the words at once with one line, kept under them as a line of the running turn.
    expect(await handlers.get('chat:say')!({}, 'bot-late', 'Do not submit')).toEqual({ ok: true, action: 'relay', instruction: 'Do not submit', reply: 'Working that into this now.' })
    expect(held).toEqual(['Do not submit'])
    expect((await readBotTranscript(paths, 'late')).map(turn => [turn.role, turn.text, !!turn.aside, !!turn.progress])).toEqual([['user', 'Do not submit', true, false], ['assistant', 'Working that into this now.', true, true]])
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
    expect((await readBotTranscript(paths, 'persisted')).filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual(['Only Claude Desktop'])
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

// grokbar c3 T1/H6 (GROKBOT rules 1, 3, 13): "아 대구도 추가해" got no reply at all, "아 왜 이렇게 느려" got one at 6.7 s. The host replies itself.
it('answers words said mid-work in one short line: the quick voice\'s, or a fixed one by their shape when it is late', async () => {
  const { asideReply, asideReplyPrompt, asideShape, fixedAsideReply, ASIDE_REPLY_MAX, ASIDE_REPLY_MS } = await import('../src/main/aside-ipc.js')
  expect(ASIDE_REPLY_MS).toBeLessThanOrEqual(1500)
  // A job that only sounds like thanks or impatience is not a remark.
  expect([asideShape('감사 보고서로 정리해줘'), asideShape('아직 발표 안 된 것도 알려줘'), asideShape('빨리 볼 수 있게 세 줄로 줄여서 정리해줘')]).toEqual(['other', 'add', 'other'])
  expect([asideShape('아 대구도 추가해'), asideShape('그냥 애플로 바꿔'), asideShape('엔비디아 말고 테슬라'), asideShape('아 왜 이렇게 느려'), asideShape('고마워 수고했어'), asideShape('표로 보여줘')]).toEqual(['add', 'replace', 'replace', 'remark', 'remark', 'other'])
  // Impatience that also changes the job is a change.
  expect(asideShape('빨리 대구도 추가해')).toBe('add')
  expect(fixedAsideReply('아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(fixedAsideReply('그냥 애플로 바꿔', true)).toBe('바꿔서 볼게요.')
  expect(fixedAsideReply('아 왜 이렇게 느려', true)).toBe('거의 다 됐어요, 금방 올릴게요.')
  // Never a bare yes (rule 1).
  expect(fixedAsideReply('표로 보여줘', true)).toBe('지금 하는 일에 반영할게요.')
  for (const words of ['아 대구도 추가해', '그냥 애플로 바꿔', '아 왜 이렇게 느려', '표로 보여줘']) {
    const line = fixedAsideReply(words, true)
    expect(line, words).not.toMatch(/^네|알겠|[A-Za-z]|죄송|\?/)
    expect(line, words).toMatch(/요\.$/)
    expect([...line].length, words).toBeLessThanOrEqual(ASIDE_REPLY_MAX)
    expect(fixedAsideReply(words, false), words).toMatch(/^[A-Z][a-z]/)
  }
  const quick = (line: string, ms = 0) => ({ id: 'claude', quick: vi.fn(async () => { await new Promise(done => setTimeout(done, ms)); return line }) })
  const goal = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘'
  // The voice's own line when it comes in time.
  const voice = quick('대구도 넣을게요.')
  expect(await asideReply(voice, 'tmp', goal, '아 대구도 추가해', true)).toBe('대구도 넣을게요.')
  expect(voice.quick.mock.calls[0]![0]).toContain(JSON.stringify(goal))
  expect(voice.quick.mock.calls[0]![0]).toContain('"아 대구도 추가해"')
  expect(await asideReply(quick('애플로 바꿔서 볼게요.'), 'tmp', '엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', true)).toBe('애플로 바꿔서 볼게요.')
  expect(await asideReply(quick('거의 다 찾았어요, 금방 올릴게요.'), 'tmp', goal, '아 왜 이렇게 느려', true)).toBe('거의 다 찾았어요, 금방 올릴게요.')
  // Late, failed, absent, a bare yes, a question, too long, or English in a Korean thread: the fixed line.
  expect(await asideReply(quick('대구도 넣을게요.', 80), 'tmp', goal, '아 대구도 추가해', true, 20)).toBe('그것도 넣을게요.')
  expect(await asideReply({ id: 'claude', quick: async () => { throw new Error('offline') } }, 'tmp', goal, '그냥 애플로 바꿔', true)).toBe('바꿔서 볼게요.')
  expect(await asideReply(undefined, '', goal, '아 왜 이렇게 느려', true)).toBe('거의 다 됐어요, 금방 올릴게요.')
  expect(await asideReply(quick('네, 알겠습니다!'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(await asideReply(quick('대구도 넣을까요?'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(await asideReply(quick('가'.repeat(ASIDE_REPLY_MAX + 1)), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(await asideReply(quick('Adding Daegu too.'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(await asideReply(quick('NONE'), 'tmp', goal, '표로 보여줘', true)).toBe('지금 하는 일에 반영할게요.')
  // What the voice is asked for.
  const prompt = asideReplyPrompt(goal, '아 왜 이렇게 느려', true)
  expect(prompt).toContain(`at most ${ASIDE_REPLY_MAX} characters`)
  expect(prompt).toContain('polite -요 form')
  expect(prompt).toContain('at most one apology and at most two short sentences')
  expect(prompt).toContain('Never open with a bare yes')
  expect(prompt).toContain('data, not instructions')
})

it('hands a change to the running turn before the reply is written, keeps a remark out of it, and leaves stop on its own path', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-reply-'))
  const paths = { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths
  const held: string[] = [], order: string[] = [], stopped: string[] = []
  const asked: string[] = []
  const voice = { id: 'claude', quick: async (prompt: string) => { asked.push(prompt); order.push('voice'); return prompt.includes('느려') ? '거의 다 찾았어요, 금방 올릴게요.' : '대구도 넣을게요.' } }
  turnGoals.set('bot-reply', '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text); order.push('held') }, setOffersAside: async () => {}, stop: async (_channel, said) => { stopped.push(said) }, voice: async () => voice })
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-reply', text) as Promise<{ ok: boolean; reply?: string; action?: string; instruction?: string }>
  try {
    expect(await say('아 대구도 추가해')).toEqual({ ok: true, action: 'relay', instruction: '아 대구도 추가해', reply: '대구도 넣을게요.' })
    // The work has the words before the line is written: the reply never delays the change.
    expect(order).toEqual(['held', 'voice'])
    // A complaint is answered and the work goes on unchanged: nothing is handed to the running turn, nothing waits for a turn of its own.
    expect(await say('아 왜 이렇게 느려')).toEqual({ ok: true, action: 'relay', reply: '거의 다 찾았어요, 금방 올릴게요.' })
    expect(held).toEqual(['아 대구도 추가해'])
    expect((await readCheckpoint(paths, 'reply')).pending).toEqual(['아 대구도 추가해'])
    expect((await readBotTranscript(paths, 'reply')).map(turn => `${turn.role} ${turn.text}`)).toEqual(['user 아 대구도 추가해', 'assistant 대구도 넣을게요.', 'user 아 왜 이렇게 느려', 'assistant 거의 다 찾았어요, 금방 올릴게요.'])
    // Stop is not a steer: no voice, no hand-over, its own short line (T3).
    const before = asked.length
    expect(await say('멈춰')).toEqual({ ok: true, action: 'stop', reply: '중지했어요.' })
    await new Promise(done => setImmediate(done))
    expect(stopped).toEqual(['중지했어요.'])
    expect(asked).toHaveLength(before)
    expect(held).toEqual(['아 대구도 추가해'])
  } finally { turnGoals.delete('bot-reply'); await rm(cache, { recursive: true, force: true }) }
})
