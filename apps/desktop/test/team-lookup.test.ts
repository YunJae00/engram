import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createTask, handBacks, listTasks, LATE_CEILING_MS, LOOKUP_MAX_CALLS, TEAM_ANSWER_MS, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Seen = { tools: string[]; options: NonNullable<Parameters<Run>[2]> }
const tool = (name: string): AgentTool => ({ name, description: '', argsSchema: {}, run: async () => name })

async function world(script: (seen: Seen) => Promise<Awaited<ReturnType<Run>>>, answerMs?: number) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-lookup-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 알려줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const seen: Seen[] = []
  const run: Run = async (deps, _prompt, options = {}) => { const one = { tools: deps.tools.map(t => t.name), options }; seen.push(one); return script(one) }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(answerMs ? { answerMs } : {}) })
  const nativeFor = vi.fn(async () => ({ cwd: '/task' }) as never)
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor,
    toolsFor: async lane => [...team.tools(lane, kit), ...['search_web', 'read_pages', 'open_page', 'look', 'ask_person', 'page_steps', 'app_click', 'excel_write', 'file_read'].map(tool)] }
  const hire = (members: Record<string, unknown>[]) => team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members }, { task: '' })
  const members = async () => (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  return { hire, members, seen, nativeFor }
}

it('runs a lookup member on the faster tier with reading tools only, no shell and a time box', async () => {
  const w = await world(async () => ({ answer: '서울 맑음 12도 (https://weather.example)', steps: [], fellBack: false }))
  const out = JSON.parse(await w.hire([{ role: '서울 조사', brief: '서울 오늘 날씨', lookup: true }, { role: '보고서', brief: '엑셀로 정리' }]))
  const [lookup, work] = w.seen
  expect(lookup!.tools.sort()).toEqual(['ask_person', 'look', 'open_page', 'read_pages', 'search_web'])
  expect(lookup!.options).toMatchObject({ role: 'deep', maxCalls: LOOKUP_MAX_CALLS })
  expect(lookup!.options.deadlineMs).toBeGreaterThan(10_000)
  expect(lookup!.options.deadlineMs).toBeLessThanOrEqual(11_000)
  expect([TEAM_ANSWER_MS, LATE_CEILING_MS, LOOKUP_MAX_CALLS]).toEqual([28_000, 90_000, 4])
  expect(lookup!.options.lookup).toBe(true)
  expect(lookup!.options.native).toBeUndefined()
  expect(lookup!.options.persona).toContain('You only look things up')
  expect(work!.tools).toEqual(expect.arrayContaining(['excel_write', 'file_read', 'page_steps', 'hire_members']))
  expect(work!.options.role).toBeUndefined()
  expect(work!.options.deadlineMs).toBeUndefined()
  expect(work!.options.native).toBeTruthy()
  expect(w.nativeFor).toHaveBeenCalledTimes(1)
  expect(out.members.map((m: { state: string }) => m.state)).toEqual(['released', 'done'])
})

it('hands the lead what a lookup member had when it stops at its call or time limit', async () => {
  const w = await world(async () => ({ answer: '부산 흐림 15도', steps: [], fellBack: false, stopped: 'calls' }))
  const out = JSON.parse(await w.hire([{ role: '부산 조사', brief: '부산 오늘 날씨', lookup: true }]))
  expect(out.members[0]).toMatchObject({ state: 'released', accepted: true, result: '부산 흐림 15도\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' })
})

it('stops a lookup member at its hard limit and still delivers what it wrote', async () => {
  const w = await world(seen => new Promise((_, reject) => {
    seen.options.onToken?.('thinking aloud'); seen.options.onReset?.(); seen.options.onStep?.('search_web: 제주 날씨'); seen.options.onToken?.('제주 비 17도')
    seen.options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
  }), 30)
  const started = Date.now()
  const out = JSON.parse(await w.hire([{ role: '제주 조사', brief: '제주 오늘 날씨', lookup: true }]))
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(out.members[0]).toMatchObject({ state: 'released', accepted: true, result: '제주 비 17도\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' })
  expect((await w.members())[0]).toMatchObject({ state: 'released', review: { ok: true } })
})

it('fails a lookup member stopped at its hard limit before it read anything, whatever it had said', async () => {
  const w = await world(seen => new Promise((_, reject) => {
    seen.options.onStart?.(); seen.options.onToken?.('먼저 기상청부터 확인.')
    seen.options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
  }), 30)
  const out = JSON.parse(await w.hire([{ role: '제주 조사', brief: '제주 오늘 날씨', lookup: true }]))
  expect(out.members[0]).toMatchObject({ state: 'failed', result: expect.stringMatching(/^Failed: /) })
})

it('counts a lookup member\'s hard limit from when it starts working, not from when it was hired', async () => {
  const w = await world(async seen => {
    await new Promise(resolve => setTimeout(resolve, 80))
    seen.options.onStart?.()
    await new Promise(resolve => setTimeout(resolve, 5))
    return { answer: '제주 비 17도 (https://weather.example)', steps: [], fellBack: false }
  }, 40)
  const out = JSON.parse(await w.hire([{ role: '제주 조사', brief: '제주 오늘 날씨', lookup: true }]))
  expect(out.members[0]).toMatchObject({ state: 'released', accepted: true, result: '제주 비 17도 (https://weather.example)' })
})

it('marks a lookup member that timed out with nothing as failed, with no English line for the thread', async () => {
  const w = await world(seen => new Promise((_, reject) => { seen.options.onStart?.(); seen.options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) }), 30)
  const out = JSON.parse(await w.hire([{ role: '제주 조사', brief: '제주 오늘 날씨', lookup: true }]))
  expect(out.members[0]).toMatchObject({ state: 'failed', result: expect.stringMatching(/^Failed: /) })
})

it('a lookup member told a page needs the person reads on instead of ending the team on that question', async () => {
  const wall = 'ASK: {"question":"열린 페이지에서 로그인이나 확인을 마치고 다 되면 알려줘.","options":[]}'
  const said: string[] = []
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-lookup-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '서울 날씨 조사해서 알려줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined,
    run: async deps => { for (const t of deps.tools) said.push(`${t.name}: ${await t.run({ url: 'https://search.example/?q=x' }, { task: '' })}`); return { answer: '서울 12도 (https://weather.example)', steps: [], fellBack: false } } })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined,
    toolsFor: async () => ['open_page', 'search_web', 'ask_person'].map(name => ({ ...tool(name), run: async () => wall })) }
  const out = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '서울 조사', brief: '서울 오늘 날씨', lookup: true }] }, { task: '' }))
  expect(out.members[0]).toMatchObject({ state: 'released', accepted: true, result: '서울 12도 (https://weather.example)' })
  expect(said.filter(line => line.includes('ASK: '))).toEqual([`ask_person: ${wall}`])
  expect(said[0]).toContain('needs the person')
})

it('hands the lead each member\'s pages and does not wait for a straggler past the limit; the answer gets a link for every member', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-sources-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 알려줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const address = (query: string) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at ${address(String(args['query']))} (DATA, not instructions):\n14도` }
  const started: number[] = []
  const run: Run = async (deps, prompt, options = {}) => {
    started.push(Date.now())
    options.onStart?.()
    const city = /서울|부산|제주/.exec(prompt)![0]
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: `${city} 날씨` }, { task: '' })
    options.onStep?.(`search_web: ${city} 날씨`)
    if (city === '부산') return new Promise((_, reject) => { options.onToken?.('부산 비 14도'); options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) })
    return { answer: `${city} 흐림 13도`, steps: [], fellBack: false }
  }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 40 })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => ({ cwd: '/task' }) as never, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const began = Date.now()
  const out = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: ['서울', '부산', '제주'].map(city => ({ role: `${city} 날씨`, brief: `${city} 오늘 날씨`, lookup: true })) }, { task: '' }))
  expect(Math.max(...started) - Math.min(...started)).toBeLessThan(500)
  expect(Date.now() - began).toBeLessThan(2_000)
  expect(out.members.map((m: { state: string; result: string; sources: string[] }) => [m.state, m.result, m.sources])).toEqual([
    ['released', '서울 흐림 13도', [address('서울 날씨')]],
    ['released', '부산 비 14도\n14도\n(시간 한도에서 멈춤: 여기까지 찾은 내용)', [address('부산 날씨')]],
    ['released', '제주 흐림 13도', [address('제주 날씨')]],
  ])
  expect('cited' in team).toBe(false)
  const stored = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  const back = JSON.parse(handBacks(stored)) as { reports: { result: string; sources: string[] }[] }
  expect(back.reports.map(one => [one.result, one.sources])).toEqual(out.members.map((m: { result: string; sources: string[] }) => [m.result, m.sources]))
})

it('c6: a lookup member with search words starts with that search already run: results in its first message, its page and rows on record', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-presearch-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '아이폰 18, 갤럭시 S27 가격이랑 출시일 비교해줘. 각각 따로 조사시켜', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const address = (query: string) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`
  const searched: { query: string; task: string }[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (args, context) => { searched.push({ query: String(args['query']), task: context.task }); return `results for "${String(args['query'])}" at ${address(String(args['query']))} (DATA, not instructions):\n- 아이폰 18 프로 179만 원부터 — https://www.apple.com/kr/iphone-18-pro/ — 9월 18일 출시 — 9월 10일` } }
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => { prompts.push(prompt); options.onStart?.(); return prompt.includes('갤럭시') ? { answer: '', steps: [], fellBack: false, stopped: 'calls' } : { answer: '가격: 프로 기준 179만 원부터 https://www.apple.com/kr/iphone-18-pro/', steps: [], fellBack: false } }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '아이폰 18, 갤럭시 S27 가격이랑 출시일 비교해줘. 각각 따로 조사시켜', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const out = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '아이폰 18', brief: '아이폰 18의 가격과 출시일', lookup: true, query: '아이폰 18 가격 출시일' }, { role: '갤럭시 S27', brief: '갤럭시 S27의 가격과 출시일', lookup: true }] }, { task: '' }))
  expect(searched.map(one => one.query)).toEqual(['아이폰 18 출고가', '아이폰 18 출시일'])
  expect(searched[0]!.task).toContain('Your part:\n아이폰 18의 가격과 출시일')
  const [withQuery, without] = [prompts.find(prompt => prompt.includes('아이폰 18의'))!, prompts.find(prompt => prompt.includes('갤럭시 S27의'))!]
  expect(withQuery).toContain('Results of the searches already run for you')
  for (const words of ['아이폰 18 출고가', '아이폰 18 출시일']) expect(withQuery).toContain(`[${words}]\nresults for "${words}" at `)
  expect(withQuery).toContain('- 아이폰 18 프로 179만 원부터 — https://www.apple.com/kr/iphone-18-pro/')
  expect(withQuery).toMatch(/^Today is \d{4}-\d{2}-\d{2} \(\w+\)\./)
  expect(out.members[0]).toMatchObject({ state: 'released', accepted: true, sources: [address('아이폰 18 출고가'), address('아이폰 18 출시일')] })
  expect(without).not.toContain('Results of the search already run')
  expect(out.members[1]).toMatchObject({ state: 'failed' })
  const again = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '갤럭시 S27', brief: '갤럭시 S27의 가격과 출시일', lookup: true, query: '갤럭시 S27 가격 출시일' }] }, { task: '' }))
  expect(again.members[0]).toMatchObject({ state: 'released', accepted: true })
  expect(again.members[0].result).toContain('아이폰 18 프로 179만 원부터: 9월 18일 출시, 9월 10일 https://www.apple.com/kr/iphone-18-pro/')
  expect(again.note).not.toContain('Review each member with review_member')
})

it('c6: results early leave room for a second search; results late say to answer now, the next call is not run, and the member ends done with its answer', async () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const outs: string[] = []
  let ran = 0
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const make = async (firstAt: number) => {
    const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-gate-')), '.engram') } as unknown as VaultPaths
    const created = await createTask(paths, '픽셀 11 가격 조사해줘', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { ran++; return `results for "${String(args['query'])}" at https://search.naver.com/search.naver?query=x (DATA, not instructions):\n- 픽셀 11 999유로 — https://ko.vidabytes.com/pixel-11/` } }
    const run: Run = async (deps, _prompt, options = {}) => {
      options.onStart?.()
      const tool = deps.tools.find(t => t.name === 'search_web')!
      await wait(firstAt)
      outs.push(await tool.run({ query: '픽셀 11 가격' }, { task: '' }))
      await wait(350)
      outs.push(await tool.run({ query: 'Pixel 11 price' }, { task: '' }))
      return { answer: '가격: 미발표, 예상 999유로 https://ko.vidabytes.com/pixel-11/', steps: [], fellBack: false }
    }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 1_650 })
    const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    return JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '픽셀 11', brief: '픽셀 11의 가격', lookup: true }] }, { task: '' }))
  }
  await make(200)
  expect(outs[0]).not.toContain('No further tool call will run')
  expect(outs[1]).toMatch(/^results for "Pixel 11 price"/)
  expect(ran).toBe(2)
  outs.length = 0; ran = 0
  const late = await make(850)
  expect(outs[0]).toMatch(/^results for "픽셀 11 가격"[^]*No further tool call will run\. Answer now from what you have/)
  expect(outs[1]).toBe('No further tool call will run. Answer now from what you have, in the person\'s language.')
  expect(ran).toBe(1)
  expect(late.members[0]).toMatchObject({ state: 'released', accepted: true, result: '가격: 미발표, 예상 999유로 https://ko.vidabytes.com/pixel-11/' })
})

it('stack-6: a pre-run search feeds what was read and where: a found-nothing part links where it looked, a cut-short answer is stored once, both accepted', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-stack6-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '이번 주 리니어, 슬랙 신기능 조사해줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const address = (query: string) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at ${address(String(args['query']))} (DATA, not instructions):\n- SMTECHNO PLC Trainer 660,000원 — https://cr3.shopping.naver.com/x — 쇼핑 — 11월 3일` }
  const slack = '슬랙이 Huddles 요약을 냈어요. https://slack.com/blog/huddles'
  const run: Run = async (_deps, prompt, options = {}) => { options.onStart?.(); return prompt.includes('리니어 신기능') ? { answer: '이번 주 리니어 신기능 관련 정보를 찾지 못했어요.', steps: [], fellBack: false } : { answer: `${slack}\n\n---\n\n**슬랙 신기능 조사 결과**\n${slack}\n\n\`\`\`replies\n더 찾아줘\n\`\`\``, steps: [], fellBack: false, stopped: 'calls' } }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const out = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '도윤', brief: '리니어 신기능 조사', lookup: true, query: '리니어 신기능' }, { role: '서연', brief: '슬랙 신기능 조사', lookup: true, query: '슬랙 신기능' }] }, { task: '' }))
  expect(out.members.map((m: { state: string; accepted?: boolean }) => [m.state, m.accepted])).toEqual([['released', true], ['released', true]])
  expect(out.note).not.toContain('Review each member with review_member')
  const [doyun, seoyeon] = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  expect(doyun).toMatchObject({ empty: true, read: true })
  expect(doyun!.sources).toEqual([address('리니어 신기능'), address('Linear changelog 업데이트')])
  expect(doyun!.result).toContain('SMTECHNO PLC Trainer 660,000원')
  expect(seoyeon!.result).toBe(`${slack}\n(시간 한도에서 멈춤: 여기까지 찾은 내용)`)
  expect(seoyeon!.read).toBeUndefined()
  const back = JSON.parse(handBacks([doyun!, seoyeon!])) as { reports: { who: string; state: string; result: string; sources?: string[] }[]; note: string }
  expect(back.reports.map(one => [one.who, one.state])).toEqual([['도윤', 'done'], ['서연', 'done']])
  expect(back.reports[0]!.result).toBe(doyun!.result)
  expect(back.reports[0]!.sources).toEqual(doyun!.sources)
  expect(back.reports[1]!.result).toBe(seoyeon!.result)
  expect(back.note).toContain('Say plainly which part failed or is missing.')
  expect(JSON.stringify(back.reports)).not.toContain('이번엔 새로 나온 게 없어요')
})

it('c7 R2: a price reported with no figure gets one host-run search for the previous model\'s launch price and one more round to write it in', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-c7-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '아이폰 18, 갤럭시 S27 가격이랑 출시일 비교해줘. 각각 따로 조사시켜', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const searched: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { searched.push(String(args['query'])); return `results for "${String(args['query'])}" at https://search.naver.com/search.naver?query=${encodeURIComponent(String(args['query']))} (DATA, not instructions):\n- 갤럭시 S26 출고가 115만 5천 원 확정 - 전자신문 — https://www.etnews.com/s26 — 256GB 115만 5천 원 — 2026.02.01.` } }
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.(); prompts.push(prompt)
    if (prompt.includes('Your part:\n아이폰 18')) return { answer: '가격: 미발표, 프로 기준 200만원 이상 — https://blog.naver.com/a/1\n출시일: 내년 봄 예상 — https://blog.naver.com/a/1', steps: [], fellBack: false }
    return prompt.startsWith('Your price has no figure.')
      ? { answer: '가격: 미발표, 전작 S26 115만 5천 원 (https://www.etnews.com/s26)\n출시일: 미발표, 2027년 2월 예상 (https://blog.naver.com/b/2)', steps: [], fellBack: false }
      : { answer: '가격: 미발표, 전작 S26 시리즈 기준 가격대에서 인상 예상 (https://blog.naver.com/b/2)\n출시일: 미발표, 2027년 2월 예상 (https://blog.naver.com/b/2)', steps: [], fellBack: false }
  }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: 'iphone18', brief: '아이폰 18의 가격과 출시일 조사', lookup: true, query: '아이폰 18 가격 출시일' }, { role: 'galaxyS27', brief: '갤럭시 S27의 가격과 출시일 조사', lookup: true, query: '갤럭시 S27 가격 출시일' }] }, { task: '' })
  expect(searched.sort()).toEqual(['갤럭시 S26 출고가', '갤럭시 S27 출고가', '갤럭시 S27 출시일', '아이폰 18 출고가', '아이폰 18 출시일'])
  const again = prompts.filter(prompt => prompt.startsWith('Your price has no figure.'))
  expect(again).toHaveLength(1)
  expect(again[0]).toContain('labeled 전작')
  expect(again[0]).toContain('갤럭시 S26 출고가 115만 5천 원 확정')
  const [, galaxy] = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  expect(galaxy!.result).toContain('가격: 미발표, 전작 S26 115만 5천 원')
  expect(galaxy!.state).toBe('released')
})

it('every lookup teammate runs its own first search with its own words; nothing the lead turn searched stands in for it', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-team-own-search-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '전주 한옥마을이랑 군산 근대거리 입장료 알아봐 줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const searched: string[] = []
  const rows = (query: string): string => `results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):\n- ${query} 안내 — https://tour.example/${encodeURIComponent(query)} — 무료 — 2026.11.01.`
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { searched.push(String(args['query'])); return rows(String(args['query'])) } }
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => { options.onStart?.(); prompts.push(prompt); return { answer: '입장료: 무료 https://tour.example/a', steps: [], fellBack: false } }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: 'jeonju', brief: '전주 한옥마을 입장료 조사', lookup: true, query: '전주 한옥마을 입장료' }, { role: 'gunsan', brief: '군산 근대거리 입장료 조사', lookup: true, query: '군산 근대거리 입장료' }] }, { task: '' })
  expect(searched.sort()).toEqual(['군산 근대거리 입장료', '전주 한옥마을 입장료'])
  expect(prompts.filter(prompt => prompt.includes('https://tour.example/'))).toHaveLength(2)
  expect('laneSearches' in await import('../src/main/team-runner.js')).toBe(false)
})
