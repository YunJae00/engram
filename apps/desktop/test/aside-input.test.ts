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
import { beginFirstLine, endFirstLine, firstLineCarried, firstLineReady, firstLineSaw, quickAnswerPrompt } from '../src/main/first-line.js'
import { broadcast, tapBroadcast } from '../src/main/engine-health.js'
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
    expect(await handlers.get('chat:say')!({}, 'bot-late', 'Do not submit')).toEqual({ ok: true, action: 'relay', instruction: 'Do not submit', reply: 'Taking that in, posting it shortly.' })
    expect(held).toEqual(['Do not submit'])
    expect((await readBotTranscript(paths, 'late')).map(turn => [turn.role, turn.text, !!turn.aside, !!turn.progress])).toEqual([['user', 'Do not submit', true, false], ['assistant', 'Taking that in, posting it shortly.', true, true]])
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
    expect(await handlers.get('chat:say')!({}, 'bot-team', '멈춰')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    // grokbar review r1: the reply is in the thread's language, not the stop word's.
    expect(await handlers.get('chat:say')!({}, 'bot-team', 'stop')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    await appendBotTurn(paths, 'en', { role: 'user', text: 'Compare the three phones', at: new Date().toISOString() })
    expect(await handlers.get('chat:say')!({}, 'bot-en', 'stop')).toEqual({ ok: true, action: 'stop', reply: 'Stopped.' })
    turnGoals.set('bot-fresh', '아이폰 18 가격 조사해줘')
    expect(await handlers.get('chat:say')!({}, 'bot-fresh', 'Cancel')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    turnGoals.delete('bot-fresh')
    // The answer is back before the stop runs: nothing was stopped yet when it returned.
    expect(stopped).toEqual([['bot-team', '멈췄어요.'], ['bot-team', '멈췄어요.'], ['bot-en', 'Stopped.']])
    await new Promise(done => setImmediate(done))
    expect(stopped).toEqual([['bot-team', '멈췄어요.'], ['bot-team', '멈췄어요.'], ['bot-en', 'Stopped.'], ['bot-fresh', '멈췄어요.']])
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
  // c3a review r1 #1: thanks or impatience with a job behind it is a change, whatever verb it uses; alone it stays a remark.
  expect(['고마워, 대구 넣어줘', '느려, 표로 줘', '수고했어 이제 부산 날씨 봐줘', 'thanks, check Busan'].map(asideShape)).toEqual(['other', 'other', 'other', 'other'])
  expect(['고마워요!', '아 진짜 너무 느려', '언제 끝나?', '아직 멀었어?', '빨리 좀 해줘', 'thanks'].map(asideShape)).toEqual(Array(6).fill('remark'))
  expect(fixedAsideReply('아 대구도 추가해', true)).toBe('그것도 넣을게요.')
  expect(fixedAsideReply('그냥 애플로 바꿔', true)).toBe('바꿔서 볼게요.')
  expect(fixedAsideReply('아 왜 이렇게 느려', true)).toBe('거의 다 됐어요, 금방 올릴게요.')
  // Never a bare yes (rule 1).
  expect(fixedAsideReply('표로 보여줘', true)).toBe('하신 말씀까지 챙겨서 금방 올릴게요.')
  expect([asideShape('내 일정 뭐 있어?'), fixedAsideReply('내 일정 뭐 있어?', true)]).toEqual(['question', '그것도 같이 챙길게요.'])
  for (const words of ['아 대구도 추가해', '그냥 애플로 바꿔', '아 왜 이렇게 느려', '표로 보여줘', '내 일정 뭐 있어?']) {
    const line = fixedAsideReply(words, true)
    expect(line, words).not.toMatch(/^네|알겠|[A-Za-z]|죄송|\?/)
    expect(line, words).toMatch(/요\.$/)
    expect([...line].length, words).toBeLessThanOrEqual(ASIDE_REPLY_MAX)
    expect(fixedAsideReply(words, false), words).toMatch(/^[A-Z][a-z]/)
  }
  const quick = (line: string, ms = 0) => ({ id: 'claude', quick: vi.fn(async () => { await new Promise(done => setTimeout(done, ms)); return line }) })
  const goal = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘'
  // The voice's own line when it comes in time.
  const voice = quick('대구도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(voice, 'tmp', goal, '아 대구도 추가해', true)).toBe('대구도 한 명 더 붙여서 볼게요.')
  // stack-9 (c9a run T1): on a split job an addition that does not say one more is on it reads as an unexplained extra teammate.
  expect(await asideReply(quick('대구도 함께 조사해서 볼게요.'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('대구도 넣을게요.'), 'tmp', '서울 날씨 알려줘', '아 대구도 추가해', true)).toBe('대구도 넣을게요.')
  expect(voice.quick.mock.calls[0]![0]).toContain(JSON.stringify(goal))
  expect(voice.quick.mock.calls[0]![0]).toContain('"아 대구도 추가해"')
  expect(await asideReply(quick('애플로 바꿔서 볼게요.'), 'tmp', '엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', true)).toBe('애플로 바꿔서 볼게요.')
  expect(await asideReply(quick('거의 다 찾았어요, 금방 올릴게요.'), 'tmp', goal, '아 왜 이렇게 느려', true)).toBe('거의 다 찾았어요, 금방 올릴게요.')
  // Late, failed, absent, a bare yes, a question, too long, or English in a Korean thread: the fixed line.
  // c6 T1: this job is a split ("봇 3개 생성해서 …"), so the fixed line for an added part says one more is put on it.
  expect(asideReplyPrompt(goal, '아 대구도 추가해', true)).toContain('say one more is put on it, naming it ("대구도 한 명 더 붙여서 볼게요.")')
  expect(asideReplyPrompt('엔비디아 오늘 주가 알려줘', '애플도 추가해', true)).toContain('say you are adding it, naming it ("대구도 넣을게요.")')
  expect(await asideReply(undefined, '', '엔비디아 오늘 주가 알려줘', '애플도 추가해', true)).toBe('그것도 넣을게요.')
  expect(await asideReply(quick('대구도 넣을게요.', 80), 'tmp', goal, '아 대구도 추가해', true, 20)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply({ id: 'claude', quick: async () => { throw new Error('offline') } }, 'tmp', goal, '그냥 애플로 바꿔', true)).toBe('바꿔서 볼게요.')
  expect(await asideReply(undefined, '', goal, '아 왜 이렇게 느려', true)).toBe('거의 다 됐어요, 금방 올릴게요.')
  expect(await asideReply(quick('네, 알겠습니다!'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('대구도 넣을까요?'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('가'.repeat(ASIDE_REPLY_MAX + 1)), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('Adding Daegu too.'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  // c3a review r1 #3: one Korean word does not make a Korean line; English the person did not write themselves is refused.
  expect(await asideReply(quick('대구도 넣을게요. Searching the web for results'), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('running 상태예요.'), 'tmp', goal, '아 왜 이렇게 느려', true)).toBe('거의 다 됐어요, 금방 올릴게요.')
  expect(await asideReply(quick('iPhone도 한 명 더 붙여서 볼게요.'), 'tmp', goal, 'iPhone도 추가해', true)).toBe('iPhone도 한 명 더 붙여서 볼게요.')
  // c3a review r1 #2: the budget starts before the voice is found, so a slow sign-in probe cannot hold the reply.
  const began = Date.now()
  expect(await asideReply(new Promise(found => setTimeout(() => found(quick('대구도 넣을게요.')), 400)), 'tmp', goal, '아 대구도 추가해', true, 30)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(Date.now() - began).toBeLessThan(300)
  expect(await asideReply(Promise.reject(new Error('no voice')), 'tmp', goal, '아 대구도 추가해', true)).toBe('그것도 한 명 더 붙여서 볼게요.')
  expect(await asideReply(quick('NONE'), 'tmp', goal, '표로 보여줘', true)).toBe('하신 말씀까지 챙겨서 금방 올릴게요.')
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
  const asked: string[] = [], answers: string[] = []
  const voice = { id: 'claude', quick: async (prompt: string) => { asked.push(prompt); order.push('voice'); return answers.shift() ?? (prompt.includes('느려') ? 'REMARK: 거의 다 찾았어요, 금방 올릴게요.' : 'CHANGE: 대구도 한 명 더 붙여서 볼게요.') } }
  turnGoals.set('bot-reply', '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text); order.push('held') }, setOffersAside: async () => {}, stop: async (_channel, said) => { stopped.push(said) }, voice: async () => voice })
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-reply', text) as Promise<{ ok: boolean; reply?: string; action?: string; instruction?: string }>
  try {
    expect(await say('아 대구도 추가해')).toEqual({ ok: true, action: 'relay', instruction: '아 대구도 추가해', reply: '대구도 한 명 더 붙여서 볼게요.' })
    // c11b r2: the voice's verdict decides the hand-over, so the work has the words right after that one quick call.
    expect(order).toEqual(['voice', 'held'])
    // A complaint is answered and the work goes on unchanged: nothing is handed to the running turn, nothing waits for a turn of its own.
    expect(await say('아 왜 이렇게 느려')).toEqual({ ok: true, action: 'relay', reply: '거의 다 찾았어요, 금방 올릴게요.' })
    expect(held).toEqual(['아 대구도 추가해'])
    expect((await readCheckpoint(paths, 'reply')).pending).toEqual(['아 대구도 추가해'])
    expect((await readBotTranscript(paths, 'reply')).map(turn => `${turn.role} ${turn.text}`)).toEqual(['user 아 대구도 추가해', 'assistant 대구도 한 명 더 붙여서 볼게요.', 'user 아 왜 이렇게 느려', 'assistant 거의 다 찾았어요, 금방 올릴게요.'])
    // Thanks with a job behind it reaches the turn (review r1 #1).
    expect((await say('고마워, 대구 넣어줘')).instruction).toBe('고마워, 대구 넣어줘')
    expect(held).toEqual(['아 대구도 추가해', '고마워, 대구 넣어줘'])
    held.pop()
    // c3a review r2 #2: a question of its own said mid-work ("1년은 몇 초야?") is answered at once and the work goes on unchanged (rule 2).
    answers.push('31,536,000초예요.')
    expect(await say('1년은 몇 초야?')).toEqual({ ok: true, action: 'relay', reply: '31,536,000초예요.' })
    expect(asked.at(-1)).toBe(quickAnswerPrompt('1년은 몇 초야?', true))
    expect(held).toEqual(['아 대구도 추가해'])
    expect((await readBotTranscript(paths, 'reply')).slice(-2).map(turn => [turn.role, turn.text, !!turn.aside, !!turn.progress])).toEqual([['user', '1년은 몇 초야?', true, false], ['assistant', '31,536,000초예요.', true, true]])
    // The voice is unsure (NONE), or answers in English nobody asked for: the question goes to the running work, with one fixed line and no second wait.
    for (const line of ['NONE', 'There are 31,536,000 seconds.']) {
      answers.push(line)
      const count = asked.length
      expect(await say('1마일은 몇 km야?')).toEqual({ ok: true, action: 'relay', instruction: '1마일은 몇 km야?', reply: '그것도 같이 챙길게요.' })
      expect(asked).toHaveLength(count + 1)
      expect(held.pop()).toBe('1마일은 몇 km야?')
    }
    // A question that needs the person's own things is not the quick voice's to answer: it is handed over and gets the usual reply line.
    expect((await say('내 일정 뭐 있어?')).instruction).toBe('내 일정 뭐 있어?')
    expect(asked.at(-1)).toContain('in the middle of the job')
    held.pop()
    const before = asked.length
    // c4 (stack-3 risk 3): the words handed over so far are also in the saved waiting list; a stop clears that copy too.
    expect((await readCheckpoint(paths, 'reply')).pending.length).toBeGreaterThan(0)
    expect(await say('멈춰')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    expect((await readCheckpoint(paths, 'reply')).pending).toEqual([])
    await new Promise(done => setImmediate(done))
    expect(stopped).toEqual(['멈췄어요.'])
    expect(asked).toHaveLength(before)
    expect(held).toEqual(['아 대구도 추가해'])
    // c3a review r3 #2: "멈춰" said while an earlier message still waits for the quick voice. That message says nothing after the stop,
    // is not handed to the stopped work and leaves nothing waiting, whether it was a question of its own or a change.
    for (const [words, line] of [['1톤은 몇 kg야?', '1,000kg이에요.'], ['아 광주도 추가해', '광주도 넣을게요.']] as const) {
      const rows = (await readBotTranscript(paths, 'reply')).length, pending = (await readCheckpoint(paths, 'reply')).pending
      let release = (): void => {}
      const waiting = new Promise<void>(done => { release = done })
      const slow = voice.quick
      // A change is handed over before its line is asked for (above), so only the stop that lands before the hand-over is checked for it.
      voice.quick = async () => { await waiting; return line }
      const early = say(words)
      await new Promise(done => setTimeout(done, 20))
      expect((await say('멈춰')).action).toBe('stop')
      release()
      expect(await early).toEqual({ ok: true })
      voice.quick = slow
      expect((await readBotTranscript(paths, 'reply')).slice(rows).map(turn => `${turn.role} ${turn.text}`)).toEqual([`user ${words}`, 'user 멈춰'])
      if (words.includes('?')) { expect(held).toEqual(['아 대구도 추가해']); expect((await readCheckpoint(paths, 'reply')).pending).toEqual(pending) }
      // A change said less than the voice's wait before the stop was already saved as waiting: the stop took it back.
      else expect((await readCheckpoint(paths, 'reply')).pending).toEqual([])
    }
  } finally { turnGoals.delete('bot-reply'); await rm(cache, { recursive: true, force: true }) }
})

// stack-7 (c7a run, T2): "엔비디아 오늘 주가 알려줘" / "그냥 애플로 바꿔" / "애플로 바꿔서 볼게요." / "지금 시세 확인할게요." / answer. With the
// host running the first search no tool call had frozen the lookup's first line when the person spoke, so it was drawn under the reply.
it('stack-7: a lookup\'s first line still live when the person speaks mid-work is closed as its own line before their words are saved', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-first-line-'))
  const paths = { cache } as VaultPaths
  const resets = (): unknown[] => vi.mocked(broadcast).mock.calls.map(([event]) => event).filter(event => (event as { reset?: boolean }).reset)
  registerAsideIpc({ paths, busy: () => true, followUp: () => () => {}, setOffersAside: async () => {} })
  try {
    vi.mocked(broadcast).mockClear()
    // The broadcast is mocked here; in the app every event passes firstLineSaw (ipc.ts tapBroadcast).
    vi.mocked(broadcast).mockImplementation(event => { firstLineSaw(event as { type: string; channel?: string; reset?: boolean }) })
    beginFirstLine({ host: false, channel: 'bot-t2', message: '엔비디아 오늘 주가 알려줘', korean: true, interactive: true, engine: async () => ({ id: 'claude' as const, quick: async () => '' }) as never, workdir: '' as never, signal: new AbortController().signal, show: () => {}, line: '지금 시세 확인할게요.' })
    firstLineReady('bot-t2')
    await vi.waitFor(() => expect(firstLineCarried('bot-t2')).toBeDefined())
    expect(firstLineCarried('bot-t2')).toBe('지금 시세 확인할게요.')
    await handlers.get('chat:say')!({}, 'bot-t2', '그냥 애플로 바꿔')
    expect(resets()).toEqual([{ type: 'chat:token', channel: 'bot-t2', text: '', reset: true }])
    expect(firstLineCarried('bot-t2')).toBeUndefined()
    // Already closed (a tool call froze it, as before): nothing more is sent.
    await handlers.get('chat:say')!({}, 'bot-t2', '아 왜 이렇게 느려')
    expect(resets()).toHaveLength(1)
  } finally { vi.mocked(broadcast).mockReset(); endFirstLine('bot-t2'); await rm(cache, { recursive: true, force: true }) }
})

// c9a T2: words handed to the running turn are also offered to it as a possible change of ask, after they are queued (so the lane can take them);
// a remark is never handed and never offered.
it('offers handed words to the running lookup after queueing them, and never a remark', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-changed-'))
  const paths = { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths
  const order: string[] = []
  const voice = { id: 'claude', quick: async (prompt: string) => prompt.includes('느려') ? 'REMARK: 거의 다 찾았어요.' : 'CHANGE: 애플로 바꿔서 볼게요.' }
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => order.push(`held ${text}`), changed: (_channel, said) => order.push(`changed ${said}`), setOffersAside: async () => {}, voice: async () => voice })
  try {
    await handlers.get('chat:say')!({}, 'bot-swap', '그냥 애플로 바꿔')
    await handlers.get('chat:say')!({}, 'bot-swap', '아 왜 이렇게 느려')
    expect(order).toEqual(['held 그냥 애플로 바꿔', 'changed 그냥 애플로 바꿔'])
  } finally { await rm(cache, { recursive: true, force: true }) }
})

// c11b r2 (review #1): "아 너무 답답한데" fell outside the word-ending rule and was handed to the running work as a change. Whether words
// said mid-work change the job is the quick voice's verdict, for any wording: none of the words below is in the harness or in a host list.
it('c11b r2: the voice\'s verdict, not the wording, decides whether words said mid-work reach the running work', async () => {
  const { asideVoice, asideReplyPrompt } = await import('../src/main/aside-ipc.js')
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-verdict-'))
  const paths = { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths
  const held: string[] = []
  // A stand-in for the model: it reads the meaning (here: a fixed table of meanings), the host only obeys the tag.
  const meaning: Record<string, string> = {
    '아 너무 답답한데': 'REMARK: 거의 다 찾았어요, 금방 올릴게요.',
    '와 진짜 하세월이네': 'remark - 조금만 기다려 주세요, 금방 올릴게요.',
    '기다리다 지치겠다 ㅠ': 'REMARK: 거의 다 됐어요, 조금만요.',
    '울산 것도 같이': 'CHANGE: 울산도 넣을게요.',
    '환율은 엔화 기준으로': 'CHANGE: 엔화 기준으로 볼게요.',
  }
  const voice = { id: 'claude', quick: async (prompt: string) => Object.entries(meaning).find(([said]) => prompt.includes(JSON.stringify(said)))?.[1] ?? '' }
  turnGoals.set('bot-verdict', '요즘 국내 핀테크 투자 뉴스 3개만 찾아줘')
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {}, voice: async () => voice })
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-verdict', text) as Promise<{ ok: boolean; reply?: string; instruction?: string }>
  try {
    expect(await say('아 너무 답답한데')).toEqual({ ok: true, action: 'relay', reply: '거의 다 찾았어요, 금방 올릴게요.' })
    expect(await say('와 진짜 하세월이네')).toEqual({ ok: true, action: 'relay', reply: '조금만 기다려 주세요, 금방 올릴게요.' })
    expect((await say('기다리다 지치겠다 ㅠ')).instruction).toBeUndefined()
    expect(held).toEqual([])
    expect((await readCheckpoint(paths, 'verdict')).pending).toEqual([])
    expect(await say('울산 것도 같이')).toEqual({ ok: true, action: 'relay', instruction: '울산 것도 같이', reply: '울산도 넣을게요.' })
    expect((await say('환율은 엔화 기준으로')).instruction).toBe('환율은 엔화 기준으로')
    expect(held).toEqual(['울산 것도 같이', '환율은 엔화 기준으로'])
  } finally { turnGoals.delete('bot-verdict'); await rm(cache, { recursive: true, force: true }) }
  // A verdict with a line that fails the checks still decides; the stand-in line follows the verdict, not the wording.
  expect(await asideVoice({ id: 'claude', quick: async () => 'REMARK: Almost done, hang on.' }, 'tmp', '서울 날씨 알려줘', '표로 보여줘', true)).toEqual({ line: '거의 다 됐어요, 금방 올릴게요.', changes: false })
  expect(await asideVoice({ id: 'claude', quick: async () => 'CHANGE: 표로 정리할게요.' }, 'tmp', '서울 날씨 알려줘', '아 진짜', true)).toEqual({ line: '표로 정리할게요.', changes: true })
  // No verdict (absent, late or untagged voice): changes is unset; the line is the host's stand-in.
  expect(await asideVoice(undefined, '', '서울 날씨 알려줘', '아 진짜', true)).toEqual({ line: '거의 다 됐어요, 금방 올릴게요.' })
  expect(asideReplyPrompt('서울 날씨 알려줘', '아 진짜', true)).toContain('Judge by what it means, not by its words.')
})

// c11b r3 (review #1): with no verdict (no voice, a late one, an untagged line) the host used to read the words' meaning from their wording,
// and "아 너무 답답한데" went to the work as a change. Now it never reads meaning: unjudged words go to the running work, whose model is told
// that a remark leaves the job unchanged. Wordings below are in no harness row and no host list.
it('c11b r3: words no voice judged are handed to the running work, whose model judges them; the host never decides from wording', async () => {
  const { withSteer } = await import('core/src/agent-session')
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-unjudged-'))
  const paths = { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths
  const held: string[] = []
  const untagged = { id: 'claude', quick: async () => '조금만 더 기다려 주세요.' }
  for (const [bot, voice] of [['bot-novoice', undefined], ['bot-untagged', untagged], ['bot-late', { id: 'claude', quick: () => new Promise<string>(() => {}) }]] as const) {
    registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {}, ...(voice ? { voice: async () => voice } : {}) })
    for (const words of ['아 너무 답답한데', '이거 언제 끝나는 거예요 대체', '부산 말고 광주로']) {
      const said = await handlers.get('chat:say')!({}, bot, words) as { instruction?: string; reply?: string }
      expect(said.instruction).toBe(words)
      expect(said.reply).toMatch(/[가-힣]/)
    }
  }
  await rm(cache, { recursive: true, force: true })
  expect(held).toHaveLength(9)
  // What the running model is told with them: a remark changes nothing.
  expect(withSteer('result', ['아 너무 답답한데'], true)).toContain('when it is only a remark (a complaint, thanks), go on unchanged')
}, 15_000)
