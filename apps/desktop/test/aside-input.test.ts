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
import { followUpFor, followUpSaid, takeFollowUps, dropFollowUps } from '../src/main/midstream-followup.js'
import { runToolSession, type AgentLoopDeps, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
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
    expect(await handlers.get('chat:say')!({}, 'bot-late', 'Do not submit')).toEqual({ ok: true, action: 'relay' })
    expect(held).toEqual(['Do not submit'])
    expect((await readBotTranscript(paths, 'late')).map(turn => [turn.role, turn.text, !!turn.aside, !!turn.progress])).toEqual([['user', 'Do not submit', true, false]])
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


it('relays every message said while the turn runs, whatever it says, and refuses it once the answer is done', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-done-'))
  const paths = { cache } as VaultPaths
  const held: string[] = []
  let answered = false
  registerAsideIpc({ paths, busy: () => true, answered: () => answered, followUp: () => text => held.push(text), setOffersAside: async () => {} })
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-done', text) as Promise<{ ok: boolean }>
  const words = ['오래 걸리네요 ㅎㅎ', '창원 시세도 같이 봐 줄 수 있어?', '아 그건 됐고 목포로', '고생 많으세요', 'Make it a short list']
  try {
    for (const one of words) expect(await say(one)).toEqual({ ok: true, action: 'relay' })
    answered = true
    expect(await say('끝났으면 알려줘')).toEqual({ ok: false })
    expect(held).toEqual(words)
    expect((await readBotTranscript(paths, 'done')).map(turn => [turn.role, turn.text])).toEqual(words.map(one => ['user', one]))
  } finally { await rm(cache, { recursive: true, force: true }) }
})

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
    expect(await handlers.get('chat:say')!({}, 'bot-team', '멈춰')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    expect(await handlers.get('chat:say')!({}, 'bot-team', 'stop')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    await appendBotTurn(paths, 'en', { role: 'user', text: 'Compare the three phones', at: new Date().toISOString() })
    expect(await handlers.get('chat:say')!({}, 'bot-en', 'stop')).toEqual({ ok: true, action: 'stop', reply: 'Stopped.' })
    turnGoals.set('bot-fresh', '아이폰 18 가격 조사해줘')
    expect(await handlers.get('chat:say')!({}, 'bot-fresh', 'Cancel')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    turnGoals.delete('bot-fresh')
    expect(stopped).toEqual([['bot-team', '멈췄어요.'], ['bot-team', '멈췄어요.'], ['bot-en', 'Stopped.']])
    await new Promise(done => setImmediate(done))
    expect(stopped).toEqual([['bot-team', '멈췄어요.'], ['bot-team', '멈췄어요.'], ['bot-en', 'Stopped.'], ['bot-fresh', '멈췄어요.']])
    expect(held).toEqual([])
    expect((await readBotTranscript(paths, 'team')).map(turn => [turn.role, turn.text, turn.aside])).toEqual([['user', '멈춰', true], ['user', 'stop', true]])
    expect((await readCheckpoint(paths, 'team')).pending).toEqual([])
    busy = false
    expect(await handlers.get('chat:say')!({}, 'bot-team', '멈춰')).toEqual({ ok: false })
    expect(stopped).toHaveLength(4)
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('writes no assistant line for a message said mid-work: the person\'s words are stored and handed to the running work, and nothing else', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-no-voice-'))
  const paths = { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths
  const held: string[] = []
  turnGoals.set('bot-quiet', '다음 주 강릉 숙소 세 곳 비교해줘')
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {} })
  const words = ['주차 되는 곳만 남겨', '언제쯤 끝나요?', '1인치는 몇 센티야?', '역시 빠르네 고마워']
  try {
    for (const one of words) expect(await handlers.get('chat:say')!({}, 'bot-quiet', one)).toEqual({ ok: true, action: 'relay' })
    expect(held).toEqual(words)
    expect((await readCheckpoint(paths, 'quiet')).pending).toEqual(words)
    expect((await readBotTranscript(paths, 'quiet')).filter(turn => turn.role === 'assistant')).toEqual([])
  } finally { turnGoals.delete('bot-quiet'); await rm(cache, { recursive: true, force: true }) }
})

const tempPaths = async (name: string): Promise<{ paths: VaultPaths; done(): Promise<void> }> => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, name))
  return { paths: { cache, workspace: join(cache, 'workspace'), privateDir: join(cache, 'workspace', '.engram') } as VaultPaths, done: () => rm(cache, { recursive: true, force: true }) }
}
const sessionDeps = (runTools: (job: ToolSessionJob) => Promise<{ answer: string }>, tools: AgentLoopDeps['tools'] = []): AgentLoopDeps => ({ engine: { id: 'claude', runTools } as unknown as Engine, workdir: '/w' as EngineCwd, tools })

it('puts a message said mid-work into the running model call at once when the engine can take it live', async () => {
  const { paths, done } = await tempPaths('aside-live-')
  const channel = 'bot-live'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const heard: string[][] = []
  let started = (): void => {}
  const calling = new Promise<void>(go => { started = go })
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    const delivered = new Promise<string[]>(take => job.onSteerable?.(async said => { heard.push(said); take(said); return true }))
    started()
    const said = await delivered
    job.onSteerable?.(null)
    return { answer: `받았어요: ${said.join(' ')}` }
  }
  try {
    const run = runToolSession(sessionDeps(runTools), '광주 맛집 다섯 곳 찾아줘', { takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await calling
    expect(await handlers.get('chat:say')!({}, channel, '아 순천도 끼워 줘')).toEqual({ ok: true, action: 'relay' })
    const result = await run
    expect(heard).toHaveLength(1)
    expect(heard[0]!.join(' ')).toContain('"아 순천도 끼워 줘"')
    expect(heard[0]!.join(' ')).toContain('First answer them in one short line')
    expect(result.answer).toContain('순천')
    expect(takeFollowUps(channel)).toEqual([])
    expect((await readBotTranscript(paths, 'live')).map(turn => turn.role)).toEqual(['user'])
  } finally { dropFollowUps(channel); await done() }
})

const slowSearch = (): { tool: never; release(): void; started: Promise<void> } => {
  let release = (): void => {}
  const slow = new Promise<void>(go => { release = go })
  let begin = (): void => {}
  const started = new Promise<void>(go => { begin = go })
  return { tool: { name: 'search_web', description: 'search', argsSchema: { type: 'object', properties: {} }, run: async () => { begin(); await slow; return '렌터카 세 곳, 하루 4만 원부터' } } as never, release: () => release(), started }
}

it('hands a message said while a slow tool runs to the model at once, keeps the tool running, and gives its result to the model when it lands', async () => {
  const { paths, done } = await tempPaths('aside-slow-tool-')
  const channel = 'bot-slow'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const search = slowSearch()
  const returned: string[] = []
  const prompts: string[] = []
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    prompts.push(job.prompt)
    job.onSteerable?.(async () => false)
    if (prompts.length === 1) returned.push(String(await job.tools[0]!.run({})))
    job.onSteerable?.(null)
    return { answer: prompts.length === 1 ? '조금만 기다려 주세요.' : '제주 렌터카는 하루 4만 원부터예요.' }
  }
  try {
    const run = runToolSession(sessionDeps(runTools, [search.tool]), '제주 렌터카 가격 알아봐줘', { takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await search.started
    await handlers.get('chat:say')!({}, channel, '아 진짜 한참 걸리네')
    await vi.waitFor(() => expect(returned).toHaveLength(1))
    expect(returned[0]).toContain('"아 진짜 한참 걸리네"')
    expect(returned[0]).not.toContain('렌터카 세 곳')
    expect(prompts).toHaveLength(1)
    search.release()
    const result = await run
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('렌터카 세 곳, 하루 4만 원부터')
    expect(prompts[1]).toContain('조금만 기다려 주세요.')
    expect(result.answer).toBe('제주 렌터카는 하루 4만 원부터예요.')
  } finally { dropFollowUps(channel); await done() }
})

it('gives a slow tool\'s result to the model live when it lands after the person\'s message was already answered', async () => {
  const { paths, done } = await tempPaths('aside-slow-live-')
  const channel = 'bot-slow-live'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const search = slowSearch()
  const live: string[][] = []
  const returned: string[] = []
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    const landed = new Promise<void>(go => job.onSteerable?.(async said => { live.push(said); go(); return true }))
    returned.push(String(await job.tools[0]!.run({})))
    await landed
    job.onSteerable?.(null)
    return { answer: '하루 4만 원부터예요.' }
  }
  try {
    const run = runToolSession(sessionDeps(runTools, [search.tool]), '제주 렌터카 가격 알아봐줘', { takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await search.started
    await handlers.get('chat:say')!({}, channel, '경차로만 봐 줘')
    await vi.waitFor(() => expect(returned).toHaveLength(1))
    expect(returned[0]).toContain('"경차로만 봐 줘"')
    expect(live).toEqual([])
    search.release()
    expect((await run).answer).toBe('하루 4만 원부터예요.')
    expect(live).toHaveLength(1)
    expect(live[0]!.join('\n')).toContain('렌터카 세 곳, 하루 4만 원부터')
  } finally { dropFollowUps(channel); await done() }
})
