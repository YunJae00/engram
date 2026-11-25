import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { companyNote, createBot, createTask, handBacks, keepRead, keepSources, listTasks, loadBots, RELEVANCE_RULE, runToolSession, skipWalls, staffTool, timeBoxed, updateTask, vaultPaths, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { personaLines } from 'core/src/agent-prompt'
import { answer, openWorld } from '../src/main/answer.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const RUN = '/Users/kwon-yunjae/engram-orch/tmp/grokbar/runs/stack14-63bdfb8a'
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const scratch = async (tag: string): Promise<string> => { await mkdir(temporary, { recursive: true }); return mkdtemp(join(temporary, `engram-stack15-${tag}-`)) }

describe('C3 replay', () => {
  const said = {
    지민: ['노션', '노션은 이번 주엔 새로 낸 기능이 없고, 가장 최근에는 10월 19일에 Notion Agents 성능 향상, 새 모델 라우터 Auto, 외부 AI 연결(BYOK) 등을 담은 업데이트가 나왔어요.', 'https://www.notion.com/releases', '10월 19일'],
    서연: ['슬랙', '슬랙 Mac 앱 4.53.287 버전이 나왔는데, 새 기능 소개 없이 보안 개선 사항만 담은 업데이트였어요.', 'https://slack.com/release-notes/mac', '11월 9일'],
    도윤: ['리니어', "리니어는 이번 주엔 새 기능을 내지 않았고, 가장 최근 소식은 11월 12일에 나온 'Bring your own key(BYOK)' 기능이에요.", 'https://linear.app/changelog', '11월 12일'],
  } as const
  const members = (): TeamMember[] => Object.entries(said).map(([role, [topic, text, url]], i) => ({ id: `m${i}`, parentId: null, depth: 1, role, brief: `${topic} 이번 주 신기능`, topic, botId: `b${i}`, lookup: true, state: 'done', sessionKey: `s${i}`, hiredAt: new Date().toISOString(), result: `${text} ${url}`, sources: [url] }))
  const ask = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'
  it('all three names and pages reach the lead in the hand-back; a draft that leaves one name out is posted as written, and there is no host fallback to say the shared state', async () => {
    const got = JSON.parse(handBacks(members())) as { reports: { who: string; part: string; result: string; sources: string[] }[]; note: string }
    expect(got.reports.map(one => [one.who, one.part])).toEqual([['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']])
    for (const [role, [, text, url]] of Object.entries(said)) expect(got.reports.find(one => one.who === role)).toMatchObject({ result: `${text} ${url}`, sources: [url] })
    expect(got.note).toContain('who did what in natural sentences that name each agent')
    const draft = `세 곳 다 이번 주엔 조용했어요.\n\n노션은 지민이 봤는데 10월 19일 업데이트가 가장 최근이에요. [노션](${said.지민[2]})\n슬랙은 서연이 봤는데 11월 9일 보안 업데이트가 마지막이에요. [슬랙](${said.서연[2]})\n리니어는 11월 12일 BYOK가 가장 최근이에요. [리니어](${said.도윤[2]})`
    const shown = (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, ask, {})).answer
    console.log(`[replay C3] posted:\n${shown}`)
    expect(shown).toBe(draft)
    expect(shown).not.toContain('도윤')
    expect(Object.keys(got)).toEqual(['reports', 'note'])
  })
})

describe('C10 replay', () => {
  it('stack14\'s record with 서연 left: the lane note keeps 서연 in the record and off the team, and the lane model\'s answer is posted as written', async () => {
    if (!existsSync(join(RUN, 'vault'))) return console.log('[replay C10] stack14 vault missing: skipped')
    const root = await scratch('c10')
    await cp(join(RUN, 'vault'), root, { recursive: true })
    const paths = vaultPaths(root)
    await staffTool(paths, () => undefined).run({ remove: ['서연'] }, { task: '' })
    const tasks = JSON.parse(await readFile(join(root, 'workspace/.engram/tasks.json'), 'utf8')).tasks
    const now = new Date('2026-11-18T05:00:00+09:00'), message = '이번 주 팀이 한 일 요약해'
    const [team, record] = (await companyNote(paths, { bots: await loadBots(paths), tasks, message, chief: true, now })).split('The team\'s record') as [string, string]
    console.log(`[replay C10] record: ${record.slice(0, 600)}`)
    expect(record).toMatch(/\(서연, /)
    expect(team).not.toMatch(/- 서연 —/)
    const written = '이번 주엔 지민이랑 도윤이 경쟁사 소식을 봤어요.\n\n서연은 슬랙 쪽을 보고 나서 팀을 떠났어요.'
    expect((await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: written }) } as never, workdir: '/x', tools: [] }, message, {})).answer).toBe(written)
  })
})

describe('C5 replay', () => {
  it('지민\'s items with two dateless entries: no judge and no by-name round runs after her answer; her three lines reach the lead exactly as she wrote them', async () => {
    const root = await scratch('c5')
    const paths = { cache: join(root, '.engram') } as unknown as VaultPaths
    for (const name of ['엔그램', '지민']) await createBot(paths, { name })
    const brief = '다음 달 서울 IT 행사 일정 정리'
    const created = await createTask(paths, `이거 지민한테 맡겨: ${brief}`, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const LIST = 'https://dev-event.example/2026-12'
    const first = [
      '소프트웨이브 2026(대한민국 소프트웨어 대전)이 12월 2일부터 4일까지 코엑스에서 열려요. https://coex.example/softwave',
      `ACC 2026은 12월에 열리는 IT기술 트렌드 컨퍼런스로, 생성형 AI와 클라우드 고도화 관련 내용을 다뤄요. ${LIST}`,
      `DDD Seoul 2026은 Microsoft 기술 중심의 커뮤니티 주도 개발자 컨퍼런스예요 (2026년). ${LIST}`,
    ].join('\n')
    let runs = 0, judges = 0
    const run: Run = async (_deps, _prompt, options = {}) => { options.onStart?.(); runs++; return { answer: first, steps: [], fellBack: false } }
    const quick = async (): Promise<string | undefined> => { judges++; return undefined }
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => `results for "x" at https://search.example/?q=x (DATA, not instructions):\n- 행사 — ${LIST} — 12월 — 2026` }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '지민', brief, topic: '서울 IT 행사' }] }, { task: '' })
    const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
    console.log(`[replay C5] judges=${judges} runs=${runs}\n${answer}`)
    expect([runs, judges]).toEqual([1, 0])
    expect(m.data).toBeUndefined()
    expect(m.result).toBe(first)
    expect((JSON.parse(answer) as { reports: { who: string; result: string }[] }).reports).toMatchObject([{ who: '지민', result: first }])
    expect(answer.match(/dev-event\.example\/2026-12/g)!.length).toBeGreaterThanOrEqual(2)
  }, 20_000)
})

describe('R3 replay', () => {
  it('stack14\'s rows (2 funding + 3 not): all five reach the looking-up model as the search gave them, with one search and no judge; which are funding news is its call', async () => {
    const rows = [
      '- 건축 설계 자동화 스타트업 제너레잇이 누적 60억 원 투자 유치를 밝혔어요 — https://biz.chosun.example/1 — 11월 18일',
      '- 의료로봇 스타트업 메디인테크가 338억 원 규모 시리즈C 투자를 유치했어요 — https://asiae.example/2 — 11월 17일',
      '- 국내 우주 스타트업들이 유럽 전시회에서 1대1 비즈니스 미팅을 진행했어요 — https://platum.example/3 — 11월 17일',
      '- 3D 캐릭터 AI 룸메이트 스타트업들이 연내 시드 투자를 추진 중이에요 — https://mt.example/4 — 11월 13일',
      '- KB금융이 싱가포르에서 스타트업 데모데이를 열었어요 — https://esci.example/5 — 11월 17일',
    ]
    const queries: string[] = [], seen = new Set<string>(), kept: string[] = []
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return `results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):\n${rows.join('\n')}` } }
    const out = await timeBoxed(keepRead(keepSources(skipWalls(search), seen), kept), () => 28_000).run({ query: '로봇 청소기 신제품 출시' }, { task: '' })
    console.log(`[replay R3] queries=${JSON.stringify(queries)}\n${out}`)
    expect(out.split('\n').slice(1)).toEqual(rows)
    expect(out).toMatch(/우주|룸메이트|데모데이/)
    expect(out).not.toContain('of these rows are from the period asked')
    expect(queries).toEqual(['로봇 청소기 신제품 출시'])
    expect([...seen]).toEqual(['https://search.example/?q=1'])
    for (const url of ['https://biz.chosun.example/1', 'https://esci.example/5']) expect(kept.join('\n')).toContain(url)
  })
})

describe('H1 replay', () => {
  it('the lunch ask with the knee fact in memory: the prompt carries the relevance rule, the ask reaches the model as typed with no host note on its length, and the pick is posted as written', async () => {
    const memory = '- 다음 주 목요일에 부모님 모시고 제주도 가요. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어요'
    const lines = personaLines('persona', memory)
    console.log(`[replay H1] ${lines.slice(1).join(' | ')}`)
    expect(lines).toContain(RELEVANCE_RULE)
    const jobs: { told: string; prompt: string; modelHint?: string }[] = []
    const engine = { id: 'claude', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: { system: string; opening?: string; prompt: string; modelHint?: string }) => { jobs.push({ told: [job.system, job.opening, job.prompt].join('\n'), prompt: job.prompt, ...(job.modelHint ? { modelHint: job.modelHint } : {}) }); return { answer: '들깨 칼국수 어때요? 쌀쌀하니까요.' } } } as never
    const { result } = await answer(await openWorld(await scratch('h1'), engine), '오늘 점심에 갈 식당 하나 찍어줘', { memory, tools: [], ack: { bare: true } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.told).toContain(RELEVANCE_RULE)
    expect(jobs[0]!.prompt).toContain('오늘 점심에 갈 식당 하나 찍어줘')
    expect(jobs[0]!.told).not.toContain('This is a short ask')
    expect(jobs[0]!.modelHint).toBeUndefined()
    expect(result?.answer).toBe('들깨 칼국수 어때요? 쌀쌀하니까요.')
  })
})
