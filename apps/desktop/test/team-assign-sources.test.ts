import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createBot, createTask, listTasks, TEAM_ANSWER_MS, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamCheckDue } from '../src/main/task-runner.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { answerHtml } from '../src/renderer/src/markdown.js'

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
const stuck = (options: NonNullable<Parameters<Run>[2]>, draft: string) => new Promise<never>((_, reject) => { options.onToken?.(draft); options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) })

it('every agent stopped at the time limit still gets a link in their row, at the limit and with no check turn after', async () => {
  const w = await world(async (deps, prompt, options = {}) => {
    options.onStart?.()
    const topic = /노션|슬랙|리니어/.exec(prompt)![0]
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: `${topic} 신기능` }, { task: '' })
    options.onStep?.(`search_web: ${topic} 신기능`)
    return stuck(options, '```report\n' + JSON.stringify({ facts: [{ text: `${topic}이 AI 요약 기능을 냈어요.` }] }))
  })
  const began = Date.now()
  const answer = await w.assign()
  expect(Date.now() - began).toBeLessThan(2_000)
  const rows = answer.split('\n').filter(line => /^(?:노션|슬랙|리니어)\((?:지민|서연|도윤)\): /.test(line))
  expect(rows).toHaveLength(3)
  for (const [who, topic] of [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']]) {
    const row = rows.find(line => line.startsWith(`${topic}(${who}): `))!
    expect(row).toContain(`${topic}이 AI 요약 기능을 냈어요.`)
    expect(row).toContain(`[네이버 검색](${address(`${topic} 새 기능 업데이트`)})`)
  }
  expect(answer).not.toMatch(/한도|멈춤|stopped at/)
  expect(answer).not.toContain('(여기까지')
  expect(answer).not.toMatch(/여기까지|더 있을 수/)
  const shown = answerHtml(answer)
  expect(shown).not.toContain('answer-card')
  expect(shown).not.toContain('<table>')
  for (const [who, topic] of [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']]) expect(shown).toMatch(new RegExp(`<p>${topic}\\(${who}\\): ${topic}[^<]*<a href="https://search\\.naver\\.com/`))
  const makers: Record<string, string> = { 노션: 'Notion releases 업데이트', 슬랙: 'Slack release notes 업데이트', 리니어: 'Linear changelog 업데이트' }
  expect((await w.task()).team!.members.map(m => m.sources)).toEqual(['노션', '슬랙', '리니어'].map(topic => [address(`${topic} 새 기능 업데이트`), address(makers[topic]!), address(`${topic} 신기능`)]))
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
  expect(TEAM_ANSWER_MS).toBe(28_000)
})

it('agents that reached no page are said so in their rows, and that answer is not re-checked either', async () => {
  const w = await world(async (_deps, _prompt, options = {}) => { options.onStart?.(); return stuck(options, '') }, query => `the search for "${query}" did not run: the results page could not be loaded (offline).`)
  const answer = await w.assign()
  expect(answer.split('\n').filter(line => /^(?:노션|슬랙|리니어)\((?:지민|서연|도윤)\): 이번엔 못 찾았어요\.$/.test(line))).toHaveLength(3)
  expect(answer).not.toMatch(/https?:/)
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
})

it('c4: agents stopped before they wrote anything still fill their rows from what they read', async () => {
  const w = await world(async (deps, prompt, options = {}) => {
    options.onStart?.()
    const topic = /노션|슬랙|리니어/.exec(prompt)![0]
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: `${topic} 신기능` }, { task: '' })
    options.onStep?.(`search_web: ${topic} 신기능`)
    return stuck(options, topic === '슬랙' ? '추가로 검색하겠습니다.' : '')
  })
  const answer = await w.assign()
  expect(answer).not.toMatch(/못 찾았어요|한도|멈춤|여기까지|더 있을 수/)
  for (const [who, topic] of [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']]) expect(answer.split('\n')).toContain(`${topic}(${who}): 이번엔 끝까지 못 봤어요. 보던 곳은 [네이버 검색](${address(`${topic} 새 기능 업데이트`)})`)
  expect(answer).not.toMatch(/추가로 검색|\[출처\]/)
  expect((await w.task()).team!.members.map(m => [m.state, m.read])).toEqual([['released', undefined], ['released', undefined], ['released', undefined]])
})

it('stack-6: teammates that never got to search still fill their rows, from the search the host ran for each part', async () => {
  const w = await world(async (_deps, _prompt, options = {}) => { options.onStart?.(); return stuck(options, '') })
  const answer = await w.assign()
  expect(answer).not.toMatch(/못 찾았어요|한도|멈춤/)
  for (const [who, topic] of [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']]) expect(answer.split('\n')).toContain(`${topic}(${who}): 이번엔 끝까지 못 봤어요. 보던 곳은 [네이버 검색](${address(`${topic} 새 기능 업데이트`)})`)
  expect(answer).not.toMatch(/추가로 검색|\[출처\]/)
  expect((await w.task()).team!.members.map(m => [m.query, m.read])).toEqual([['노션 새 기능 업데이트', undefined], ['슬랙 새 기능 업데이트', undefined], ['리니어 새 기능 업데이트', undefined]])
})
