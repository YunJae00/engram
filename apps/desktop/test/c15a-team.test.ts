import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { asides, turnGoals } from '../src/main/turn-state.js'

// c15a (cause K, C5: a judge slower than the fixed 3 s gave no verdict, so no by-name round ran and entries were shown with no day). Every
// item-judge call on the team path now takes its time from the part's deadline. Wordings are in no harness row.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const temporary = async (tag: string): Promise<VaultPaths> => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  return { cache: join(await mkdtemp(join(root, `engram-c15a-${tag}-`)), '.engram') } as unknown as VaultPaths
}
afterEach(() => { turnGoals.delete('bot-b1'); asides.delete('bot-b1') })

it('C5 class: a judge that answers in 4.5 s still gets its verdict, so two dateless entries are looked up by name and shown with their days', async () => {
  const paths = await temporary('slow-judge')
  for (const name of ['엔그램', '하윤']) await createBot(paths, { name })
  const brief = '다음 달 지역 메이커 행사 일정 정리'
  const created = await createTask(paths, `하윤한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const PAGE = 'https://maker.example.kr/events/2026'
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    if (prompt.includes('Search each entry by its own name')) return { answer: block({ facts: [{ text: '부산 디자인 페어는 12월 4일 벡스코에서 열려요.', url: 'https://maker.example.kr/busan', date: '12월 4일' }, { text: '광주 메이커 위크는 12월 11일 김대중컨벤션센터에서 열려요.', url: 'https://maker.example.kr/gwangju', date: '12월 11일' }] }), steps: [], fellBack: false }
    return { answer: block({ facts: [{ text: '부산 디자인 페어가 12월에 열려요.', url: PAGE }, { text: '광주 메이커 위크가 12월에 열려요.', url: PAGE }] }), steps: [], fellBack: false }
  }
  const given: number[] = []
  // The first judgment takes 4.5 s (past the old fixed 3 s, well inside the part's deadline); the later ones 0.2 s. Real time: a fake clock races the task file's real writes.
  const quick = (prompt: string, opts: { timeoutMs?: number }): Promise<string | undefined> => {
    if (!prompt.includes('"lists"')) return Promise.resolve(undefined)
    given.push(opts.timeoutMs ?? 0)
    const verdict = /12월 \d+일/.test(prompt) ? '{"keep":[1,2],"lists":[]}' : '{"keep":[1,2],"lists":[1,2],"names":{"1":"부산 디자인 페어","2":"광주 메이커 위크"}}'
    return new Promise(resolve => setTimeout(() => resolve(verdict), given.length === 1 ? 4_500 : 200))
  }
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- 메이커 행사 — ${PAGE} — 12월 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하윤', brief, topic: '메이커 행사' }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  expect(given.length).toBeGreaterThanOrEqual(2)
  // Each call's time is what is left of the part's deadline, never the fixed 3 s.
  expect(given[0]).toBeGreaterThan(4_500)
  for (const ms of given) expect(ms).toBeGreaterThan(3_000)
  expect(m.data?.facts.filter(f => !f.listing).map(f => f.date)).toEqual(['12월 4일', '12월 11일'])
  expect(answer).toContain('12월 4일')
  expect(answer).toContain('12월 11일')
}, 20_000)
