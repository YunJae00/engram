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
  expect(m.data?.facts.map(f => [f.text, f.url])).toEqual([['성북 벼룩시장이 12월에 열려요.', PAGE], ['마포 헌책 장터가 12월에 열려요.', PAGE]])
  const back = (JSON.parse(answer) as { reports: { who: string; part: string; state: string; result: string; sources?: string[] }[] }).reports
  expect(back).toHaveLength(1)
  expect(back[0]).toMatchObject({ who: '보람', part: '벼룩시장', state: 'done' })
  expect(back[0]!.result).toBe(m.result)
  for (const words of ['성북 벼룩시장이 12월에 열려요.', '마포 헌책 장터가 12월에 열려요.', PAGE]) expect(back[0]!.result).toContain(words)
  expect(m.sources?.length).toBeGreaterThan(0)
  expect(back[0]!.sources).toEqual(m.sources)
}, 20_000)

it('what a teammate hands back in its report block reaches the lead as that teammate\'s data, a writer\'s pieces too; a teammate who answers in plain words is handed back in those words with no data', async () => {
  const paths = await temporary('handed')
  for (const name of ['엔그램', '다온', '세린', '우진']) await createBot(paths, { name })
  const created = await createTask(paths, '도서관 겨울 휴관일이랑 야간 개방 알아보고 안내 문구도 써 줘', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const CLOSED = 'https://library.example.kr/notice/winter', NIGHT = 'https://library.example.kr/night'
  const plain = `야간 개방은 평일 밤 10시까지예요. ${NIGHT}`
  const says = (persona = ''): string => persona.includes('다온') ? block({ facts: [{ text: '겨울 휴관은 1월 첫째 주예요.', url: CLOSED, date: '1월 첫째 주' }], note: '공지에 나와 있었어요.' }) : persona.includes('세린') ? plain : block({ items: ['겨울에도 책은 쉬지 않아요', '밤 10시까지 열려 있어요'] })
  const run: Run = async (_deps, _prompt, options = {}) => { options.onStart?.(); return { answer: says(options.persona), steps: [], fellBack: false } }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: { id: 'claude' } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '다온', brief: '도서관 겨울 휴관일 찾기', topic: '휴관일' }, { who: '세린', brief: '도서관 야간 개방 시간 찾기', topic: '야간 개방', then: { who: '우진', brief: '안내 문구를 2개 쓰기' } }] }, { task: '' })
  const members = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members
  const by = (who: string) => members.find(m => m.role === who)!
  expect(by('다온').data).toMatchObject({ facts: [{ text: '겨울 휴관은 1월 첫째 주예요.', url: CLOSED, date: '1월 첫째 주' }], note: '공지에 나와 있었어요.' })
  expect(by('세린').data).toBeUndefined()
  expect(by('세린').result).toBe(plain)
  expect(by('우진').data).toEqual({ facts: [], items: ['겨울에도 책은 쉬지 않아요', '밤 10시까지 열려 있어요'] })
  const back = (JSON.parse(answer) as { reports: { who: string; state: string; result: string }[] }).reports
  expect(back.map(one => [one.who, one.state])).toEqual([['다온', 'done'], ['세린', 'done'], ['우진', 'done']])
  expect(back[0]!.result).toContain('겨울 휴관은 1월 첫째 주예요')
  expect(back[0]!.result).toContain(CLOSED)
  expect(back[1]!.result).toBe(plain)
  expect(back[2]!.result).toBe('1. 겨울에도 책은 쉬지 않아요\n2. 밤 10시까지 열려 있어요')
}, 20_000)
