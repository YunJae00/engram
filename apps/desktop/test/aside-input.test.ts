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
import { takeAsides, turnGoals } from '../src/main/turn-state.js'
import { followUpFor, followUpSaid, takeFollowUps, dropFollowUps } from '../src/main/midstream-followup.js'
import { runToolSession, type AgentLoopDeps, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { acknowledgeHanded, readCheckpoint } from '../src/main/comet-checkpoint.js'
import { beginFirstLine, endFirstLine, firstLineCarried, firstLineReady, firstLineSaw } from '../src/main/first-line.js'
import { broadcast } from '../src/main/engine-health.js'

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

it('drops a message still being saved when a stop word lands meanwhile, so the stopped work never gets it', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const cache = await mkdtemp(join(temporary, 'aside-stop-race-'))
  const paths = { cache } as VaultPaths
  const held: string[] = []
  const checkpoint = await import('../src/main/comet-checkpoint.js')
  const real = checkpoint.changeCheckpoint.bind(checkpoint)
  const gated: { args: Parameters<typeof real>; release(): void }[] = []
  const change = vi.spyOn(checkpoint, 'changeCheckpoint').mockImplementation((...args) => new Promise<void>(done => { gated.push({ args, release: () => { void real(...args).then(done) } }) }))
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => held.push(text), setOffersAside: async () => {}, stop: async () => {} })
  try {
    const saying = handlers.get('chat:say')!({}, 'bot-race', '광주 숙소도 같이 봐줘')
    const stopping = handlers.get('chat:say')!({}, 'bot-race', '그만')
    await vi.waitFor(() => expect(gated).toHaveLength(2))
    const clears = (one: typeof gated[number]) => one.args[2]({ pending: ['earlier'] }).pending.length === 0
    gated.filter(clears).forEach(one => one.release())
    expect(await stopping).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    gated.filter(one => !clears(one)).forEach(one => one.release())
    expect(await saying).toEqual({ ok: true })
    expect(held).toEqual([])
    expect(takeAsides('bot-race')).toEqual([])
    expect((await readCheckpoint(paths, 'race')).pending).toEqual([])
  } finally { change.mockRestore(); await rm(cache, { recursive: true, force: true }) }
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

it('waits for something new after the engine declines a landed tool result live, and gives that result to the model in the next round instead', async () => {
  const { paths, done } = await tempPaths('aside-declined-')
  const channel = 'bot-declined'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const search = slowSearch()
  const prompts: string[] = []
  let declined = 0
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    prompts.push(job.prompt)
    if (prompts.length > 1) return { answer: '경차는 하루 3만 원대예요.' }
    job.onSteerable?.(async () => { declined++; return false })
    await job.tools[0]!.run({})
    search.release()
    await new Promise(go => setTimeout(go, 60))
    job.onSteerable?.(null)
    return { answer: '조금만요.' }
  }
  try {
    const run = runToolSession(sessionDeps(runTools, [search.tool]), '부산 경차 렌트 시세 봐줘', { takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await search.started
    await handlers.get('chat:say')!({}, channel, '오늘 안에만 알려줘요')
    const result = await run
    expect(declined).toBeLessThanOrEqual(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('렌터카 세 곳, 하루 4만 원부터')
    expect(result.answer).toBe('경차는 하루 3만 원대예요.')
  } finally { dropFollowUps(channel); await done() }
})

it('starts a new round at once for a message said after the interim reply while the slow tool is still running, then another when the tool lands', async () => {
  const { paths, done } = await tempPaths('aside-slow-second-')
  const channel = 'bot-slow-second'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const search = slowSearch()
  const prompts: string[] = []
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    prompts.push(job.prompt)
    if (prompts.length > 1) return { answer: prompts.length === 2 ? '창가 좌석으로 볼게요.' : '창가 좌석은 하루 4만 원부터예요.' }
    job.onSteerable?.(async () => false)
    await job.tools[0]!.run({})
    job.onSteerable?.(null)
    return { answer: '알아보는 중이에요.' }
  }
  try {
    const run = runToolSession(sessionDeps(runTools, [search.tool]), '강릉 가는 KTX 요금 알아봐줘', { takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await search.started
    await handlers.get('chat:say')!({}, channel, '좀 오래 걸리네요')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await new Promise(go => setTimeout(go, 20))
    await handlers.get('chat:say')!({}, channel, '창가 자리로만 알려 줘요')
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(prompts[1]).toContain('"창가 자리로만 알려 줘요"')
    expect(prompts[1]).not.toContain('렌터카 세 곳')
    search.release()
    const result = await run
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('렌터카 세 곳, 하루 4만 원부터')
    expect(result.answer).toBe('창가 좌석은 하루 4만 원부터예요.')
  } finally { dropFollowUps(channel); await done() }
})

it('tells the model when a call it was told is still running fails after the person was answered, instead of finishing as if it worked', async () => {
  const { paths, done } = await tempPaths('aside-slow-fail-')
  const channel = 'bot-slow-fail'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const search = slowSearch()
  const prompts: string[] = []
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    prompts.push(job.prompt)
    if (prompts.length > 1) return { answer: '시세를 못 불러왔어요. 다시 찾아볼게요.' }
    job.onSteerable?.(async () => false)
    await job.tools[0]!.run({})
    job.onSteerable?.(null)
    return { answer: '확인하고 있어요.' }
  }
  try {
    const run = runToolSession(sessionDeps(runTools, [search.tool]), '대구 소형 SUV 렌트비 알아봐줘', {
      takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal),
      onMetric: metric => { if (metric.kind === 'tool') throw new Error('usage log unavailable') },
    })
    await search.started
    await handlers.get('chat:say')!({}, channel, '주말 요금으로 봐 줘요')
    search.release()
    const result = await run
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('The search_web call that was still running has finished:\nthat did not work: usage log unavailable')
    expect(prompts[1]).not.toContain('렌터카 세 곳')
    expect(result.answer).toBe('시세를 못 불러왔어요. 다시 찾아볼게요.')
  } finally { dropFollowUps(channel); await done() }
})

it('answers words said mid-work in one short line written by the running model, with no quick voice and no fixed line from the host', async () => {
  const aside = await import('../src/main/aside-ipc.js')
  expect(Object.keys(aside).sort()).toEqual(['STOP_WORDS', 'noteStopped', 'registerAsideIpc'])
  const { paths, done } = await tempPaths('aside-own-line-')
  const channel = 'bot-own-line'
  registerAsideIpc({ paths, busy: () => true, followUp: followUpFor, setOffersAside: async () => {} })
  const streamed: string[] = []
  let open = (): void => {}
  const opened = new Promise<void>(go => { open = go })
  const runTools = async (job: ToolSessionJob): Promise<{ answer: string }> => {
    const said = new Promise<string[]>(take => job.onSteerable?.(async words => { take(words); return true }))
    open()
    const words = (await said).join('\n')
    job.onSteerable?.(null)
    const line = words.includes('First answer them in one short line') ? '네 명 기준으로 다시 볼게요.' : ''
    job.onToken?.(line)
    return { answer: line }
  }
  try {
    const run = runToolSession(sessionDeps(runTools), '양양 펜션 두 곳 골라줘', { onToken: text => streamed.push(text), takeSteer: () => takeFollowUps(channel), steered: signal => followUpSaid(channel, signal) })
    await opened
    const said = await handlers.get('chat:say')!({}, channel, '인원은 네 명이에요') as { reply?: string }
    expect(said.reply).toBeUndefined()
    expect((await run).answer).toBe('네 명 기준으로 다시 볼게요.')
    expect(streamed).toEqual(['네 명 기준으로 다시 볼게요.'])
    expect((await readBotTranscript(paths, 'own-line')).map(turn => turn.role)).toEqual(['user'])
  } finally { dropFollowUps(channel); await done() }
})

it('hands a change and a remark to the running turn the same way, and leaves stop on its own path', async () => {
  const { paths, done } = await tempPaths('aside-change-remark-')
  const held: string[] = [], stopped: string[] = []
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {}, stop: async (_channel, said) => { stopped.push(said) } })
  const say = (text: string) => handlers.get('chat:say')!({}, 'bot-paths', text)
  try {
    expect(await say('속초 쪽 코스도 하나 넣어줘')).toEqual({ ok: true, action: 'relay' })
    expect(await say('생각보다 오래 걸리네요')).toEqual({ ok: true, action: 'relay' })
    expect(held).toEqual(['속초 쪽 코스도 하나 넣어줘', '생각보다 오래 걸리네요'])
    expect((await readCheckpoint(paths, 'paths')).pending).toEqual(held)
    expect(await say('그만')).toEqual({ ok: true, action: 'stop', reply: '멈췄어요.' })
    await new Promise(go => setImmediate(go))
    expect(stopped).toEqual(['멈췄어요.'])
    expect(held).toHaveLength(2)
    expect((await readCheckpoint(paths, 'paths')).pending).toEqual([])
    expect((await readBotTranscript(paths, 'paths')).map(turn => turn.role)).toEqual(['user', 'user', 'user'])
  } finally { await done() }
})

it('stack-7: a lookup\'s first line still live when the person speaks mid-work stays as it is; the host neither resets it nor writes a line of its own', async () => {
  const { paths, done } = await tempPaths('aside-first-line-')
  const resets = (): unknown[] => vi.mocked(broadcast).mock.calls.map(([event]) => event).filter(event => (event as { reset?: boolean }).reset)
  registerAsideIpc({ paths, busy: () => true, followUp: () => () => {}, setOffersAside: async () => {} })
  try {
    vi.mocked(broadcast).mockClear()
    vi.mocked(broadcast).mockImplementation(event => { firstLineSaw(event as { type: string; channel?: string; reset?: boolean }) })
    beginFirstLine({ host: false, channel: 'bot-rate', message: '오늘 엔화 환율 알려줘', korean: true, interactive: true, engine: async () => ({ id: 'claude' as const, quick: async () => '지금 환율 볼게요.' }) as never, workdir: '' as never, signal: new AbortController().signal, show: () => {} })
    firstLineReady('bot-rate')
    await vi.waitFor(() => expect(firstLineCarried('bot-rate')).toBe('지금 환율 볼게요.'))
    await handlers.get('chat:say')!({}, 'bot-rate', '위안화도 같이요')
    await handlers.get('chat:say')!({}, 'bot-rate', '빨리 좀 부탁해요')
    expect(resets()).toEqual([])
    expect(firstLineCarried('bot-rate')).toBe('지금 환율 볼게요.')
    expect((await readBotTranscript(paths, 'rate')).map(turn => [turn.role, turn.text])).toEqual([['user', '위안화도 같이요'], ['user', '빨리 좀 부탁해요']])
  } finally { vi.mocked(broadcast).mockReset(); endFirstLine('bot-rate'); await done() }
})

it('holds every message said mid-work for the running turn, a remark as much as a change', async () => {
  const { paths, done } = await tempPaths('aside-held-')
  const order: string[] = []
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => order.push(`held ${text}`), setOffersAside: async () => {} })
  try {
    await handlers.get('chat:say')!({}, 'bot-held', '청주 것도 끼워서 봐줄래')
    await handlers.get('chat:say')!({}, 'bot-held', '이거 언제 돼')
    expect(order).toEqual(['held 청주 것도 끼워서 봐줄래', 'held 이거 언제 돼'])
  } finally { await done() }
})

it('c11b r2: no verdict is taken on words said mid-work; each reaches the running work as typed and stays pending until it is handed over', async () => {
  const { paths, done } = await tempPaths('aside-verdict-')
  const held: string[] = []
  turnGoals.set('bot-verdict', '요즘 국내 바이오 투자 소식 세 개만 찾아줘')
  registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {} })
  const words = ['아 너무 답답하다', '해외 건도 하나 넣어', '그냥 의료기기로 바꿔', '천천히 해도 돼요']
  try {
    for (const one of words) expect(await handlers.get('chat:say')!({}, 'bot-verdict', one)).toEqual({ ok: true, action: 'relay' })
    expect(held).toEqual(words)
    expect((await readCheckpoint(paths, 'verdict')).pending).toEqual(words)
    await acknowledgeHanded(paths, 'verdict', words.slice(0, 2))
    expect((await readCheckpoint(paths, 'verdict')).pending).toEqual(words.slice(2))
  } finally { turnGoals.delete('bot-verdict'); await done() }
})

it('c11b r3: words said mid-work go to the running model with one wording whatever they say, and the model judges them', async () => {
  const { withSteer } = await import('core/src/agent-session')
  const { paths, done } = await tempPaths('aside-unjudged-')
  const held: string[] = []
  const words = ['아 너무 답답한데', '이거 언제 끝나는 거예요 대체', '수원 말고 안양으로']
  try {
    for (const bot of ['bot-one', 'bot-two']) {
      registerAsideIpc({ paths, busy: () => true, followUp: () => text => { held.push(text) }, setOffersAside: async () => {} })
      for (const one of words) expect(await handlers.get('chat:say')!({}, bot, one)).toEqual({ ok: true, action: 'relay' })
    }
    expect(held).toEqual([...words, ...words])
    const frames = words.map(one => withSteer('result', [one]).replace(JSON.stringify(one), '<said>'))
    expect(new Set(frames).size).toBe(1)
    expect(frames[0]).toContain('First answer them in one short line')
  } finally { await done() }
})
