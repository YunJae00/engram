import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { asides, turnGoals } from '../src/main/turn-state.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const temporary = async (tag: string): Promise<VaultPaths> => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  return { cache: join(await mkdtemp(join(root, `engram-c15a-${tag}-`)), '.engram') } as unknown as VaultPaths
}
afterEach(() => { turnGoals.delete('bot-b1'); asides.delete('bot-b1') })

it('C5 class: a quick model that would take 4.5 s is never asked about a teammate\'s answer: two entries without their days reach the hand-back as written, after one model run', async () => {
  const paths = await temporary('no-judge')
  for (const name of ['엔그램', '보람']) await createBot(paths, { name })
  const brief = '다음 달 동네 벼룩시장 일정 정리'
  const created = await createTask(paths, `보람한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const PAGE = 'https://market.example.kr/flea/2026'
  const said = block({ facts: [{ text: '성북 벼룩시장이 12월에 열려요.', url: PAGE }, { text: '마포 헌책 장터가 12월에 열려요.', url: PAGE }] })
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => { options.onStart?.(); prompts.push(prompt); return { answer: said, steps: [], fellBack: false } }
  const asked: string[] = []
  const quick = (prompt: string): Promise<string | undefined> => { asked.push(prompt); return new Promise(resolve => setTimeout(() => resolve('{"keep":[1,2]}'), 4_500)) }
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- 동네 벼룩시장 — ${PAGE} — 12월 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const began = Date.now()
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '보람', brief, topic: '벼룩시장' }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  expect(Date.now() - began).toBeLessThan(4_000)
  expect(asked).toEqual([])
  expect(prompts).toHaveLength(1)
  expect(m.data).toBeUndefined()
  const back = (JSON.parse(answer) as { reports: { who: string; part: string; state: string; result: string; sources?: string[] }[] }).reports
  expect(back).toHaveLength(1)
  expect(back[0]).toMatchObject({ who: '보람', part: '벼룩시장', state: 'done' })
  expect(back[0]!.result).toBe(m.result)
  for (const words of ['성북 벼룩시장이 12월에 열려요.', '마포 헌책 장터가 12월에 열려요.', PAGE]) expect(back[0]!.result).toContain(words)
  expect(m.sources?.length).toBeGreaterThan(0)
  expect(back[0]!.sources).toEqual(m.sources)
}, 20_000)
