import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createBot, createTask, listTasks, TEAM_ANSWER_MS, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamCheckDue } from '../src/main/task-runner.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const address = (query: string) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`

async function world(run: Run, found = (query: string): string => `results for "${query}" at ${address(query)} (DATA, not instructions):\n새 기능`) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-assign-sources-')), '.engram') } as unknown as VaultPaths
  for (const name of ['엔그램', '지민', '서연', '도윤']) await createBot(paths, { name })
  const created = await createTask(paths, '경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => found(String(args['query'])) }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 40 })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const assign = () => team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']].map(([who, topic]) => ({ who, topic, brief: `${topic} 신기능 조사` })) }, { task: '' })
  const task = async () => (await listTasks(paths)).find(t => t.id === created.id)!
  return { assign, task }
}
type Back = { reports: { who: string; part: string; state: string; result: string; sources?: string[] }[]; note: string }
const TEAM = [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']] as const
const stuck = (options: NonNullable<Parameters<Run>[2]>, draft: string) => new Promise<never>((_, reject) => { options.onToken?.(draft); options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) })

it('every agent stopped at the time limit hands the lead its own words and every page it searched, at the limit and with no check turn after', async () => {
  const parts = new Map<string, string>()
  const w = await world(async (deps, prompt, options = {}) => {
    options.onStart?.()
    const topic = /노션|슬랙|리니어/.exec(prompt)?.[0] ?? parts.get(options.session!)!
    const words = `${topic}이 AI 요약 기능을 냈어요.`
    if (parts.has(options.session!)) return { answer: words, steps: [], fellBack: false }
    parts.set(options.session!, topic)
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: `${topic} 신기능` }, { task: '' })
    options.onStep?.(`search_web: ${topic} 신기능`)
    return stuck(options, words)
  })
  const began = Date.now()
  const answer = await w.assign()
  expect(Date.now() - began).toBeLessThan(2_000)
  const back = JSON.parse(answer) as Back
  expect(back.reports.map(one => [one.who, one.part, one.state])).toEqual(TEAM.map(([who, topic]) => [who, topic, 'done']))
  const makers: Record<string, string> = { 노션: 'Notion releases 업데이트', 슬랙: 'Slack release notes 업데이트', 리니어: 'Linear changelog 업데이트' }
  for (const [i, [, topic]] of TEAM.entries()) {
    expect(back.reports[i]!.result).toContain(`${topic}이 AI 요약 기능을 냈어요.`)
    expect(back.reports[i]!.sources).toEqual([address(`${topic} 새 기능 업데이트`), address(makers[topic]!), address(`${topic} 신기능`)])
  }
  expect(answer).not.toContain('[네이버 검색](')
  expect(back.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
  expect((await w.task()).team!.members.map(m => m.sources)).toEqual(back.reports.map(one => one.sources))
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
  expect(TEAM_ANSWER_MS).toBe(28_000)
})

it('agents that reached no page come back failed with no address, the lead is told to say so, and that hand-back is not re-checked either', async () => {
  const w = await world(async (_deps, _prompt, options = {}) => { options.onStart?.(); return stuck(options, '') }, query => `the search for "${query}" did not run: the results page could not be loaded (offline).`)
  const answer = await w.assign()
  const back = JSON.parse(answer) as Back
  expect(back.reports.map(one => [one.who, one.state, one.sources])).toEqual(TEAM.map(([who]) => [who, 'failed', undefined]))
  expect(answer).not.toMatch(/https?:/)
  expect(answer).not.toContain('이번엔 못 찾았어요')
  expect(back.note).toContain('Say plainly which part failed or is missing.')
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
})

it('c4: agents stopped before they wrote anything hand back what they read and where, with no row written for them', async () => {
  const w = await world(async (deps, prompt, options = {}) => {
    options.onStart?.()
    const topic = /노션|슬랙|리니어/.exec(prompt)![0]
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: `${topic} 신기능` }, { task: '' })
    options.onStep?.(`search_web: ${topic} 신기능`)
    return stuck(options, topic === '슬랙' ? '추가로 검색하겠습니다.' : '')
  })
  const answer = await w.assign()
  const back = JSON.parse(answer) as Back
  expect(answer).not.toMatch(/못 찾았어요|끝까지 못 봤어요|보던 곳은/)
  for (const [i, [who, topic]] of TEAM.entries()) {
    expect(back.reports[i]).toMatchObject({ who, part: topic, state: 'done', result: '새 기능' })
    expect(back.reports[i]!.sources![0]).toBe(address(`${topic} 새 기능 업데이트`))
  }
  expect(answer).not.toMatch(/추가로 검색|\[출처\]/)
  expect((await w.task()).team!.members.map(m => [m.state, m.read])).toEqual([['released', true], ['released', true], ['released', true]])
})

it('stack-6: teammates that never got to search still hand back the search the host ran for each part', async () => {
  const w = await world(async (_deps, _prompt, options = {}) => { options.onStart?.(); return stuck(options, '') })
  const answer = await w.assign()
  const back = JSON.parse(answer) as Back
  expect(answer).not.toMatch(/못 찾았어요|끝까지 못 봤어요|보던 곳은/)
  for (const [i, [who, topic]] of TEAM.entries()) {
    expect(back.reports[i]).toMatchObject({ who, part: topic, state: 'done' })
    expect(back.reports[i]!.result.split('\n')[0]).toBe('새 기능')
    expect(back.reports[i]!.sources![0]).toBe(address(`${topic} 새 기능 업데이트`))
  }
  expect(answer).not.toMatch(/추가로 검색|\[출처\]/)
  expect((await w.task()).team!.members.map(m => [m.query, m.read])).toEqual([['노션 새 기능 업데이트', true], ['슬랙 새 기능 업데이트', true], ['리니어 새 기능 업데이트', true]])
})
