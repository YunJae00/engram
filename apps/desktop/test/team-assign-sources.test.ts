import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createBot, createTask, listTasks, LOOKUP_HARD_MS, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamCheckDue } from '../src/main/task-runner.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// grokbar B7 review r1 (C3, stack1: 131 s, 0 links): all three agents were stopped at the time limit with no address in what they had
// written, so every source cell was '-', and the answer without an address was re-checked for another 90 s.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const address = (query: string) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`

async function world(run: Run) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-assign-sources-')), '.engram') } as unknown as VaultPaths
  for (const name of ['엔그램', '지민', '서연', '도윤']) await createBot(paths, { name })
  const created = await createTask(paths, '경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at ${address(String(args['query']))} (DATA, not instructions):\n새 기능` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, lookupHardMs: 40 })
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
    return stuck(options, `${topic}이 AI 요약 기능을 냈다`)
  })
  const began = Date.now()
  const answer = await w.assign()
  expect(Date.now() - began).toBeLessThan(2_000)
  const rows = answer.split('\n').filter(line => line.startsWith('| ')).slice(1)
  expect(rows).toHaveLength(3)
  for (const [who, topic] of [['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']]) {
    const row = rows.find(line => line.startsWith(`| ${topic} (${who}) |`))!
    expect(row).toContain(`${topic}이 AI 요약 기능을 냈다`)
    expect(row).toContain(`[search.naver.com](${address(`${topic} 신기능`)})`)
  }
  expect((await w.task()).team!.members.map(m => m.sources)).toEqual(['노션', '슬랙', '리니어'].map(topic => [address(`${topic} 신기능`)]))
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
  // The agents are held 15 s at most inside the 35 s answer.
  expect(LOOKUP_HARD_MS).toBe(15_000)
})

it('agents that reached no page are said so in their rows, and that answer is not re-checked either', async () => {
  const w = await world(async (_deps, _prompt, options = {}) => { options.onStart?.(); return stuck(options, '') })
  const answer = await w.assign()
  expect(answer.split('\n').filter(line => line.endsWith('| 조사하지 못했어요. | - |'))).toHaveLength(3)
  expect(answer).not.toMatch(/https?:/)
  expect(teamCheckDue(await w.task(), answer)).toBe(false)
})
