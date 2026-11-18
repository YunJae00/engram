import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkedSearch, createBot, createTask, listTasks, loadBots, RELEVANCE_RULE, setReportLog, staffTool, teamSummary, updateTask, vaultPaths, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { personaLines } from 'core/src/agent-prompt'
import { SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'

// stack-15 section 3: replays of stack14's failing threads (runs/stack14-63bdfb8a) through the merged code. The quick model is a fake routed
// by prompt kind; the texts are the teammates' and the rows' own words from those threads. Each result is printed for the DONE file.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const RUN = '/Users/kwon-yunjae/engram-orch/tmp/grokbar/runs/stack14-63bdfb8a'
const CHECK = 'Judge meaning only', REDO = 'Your earlier draft was'
const none = JSON.stringify({ problems: [] })
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const scratch = async (tag: string): Promise<string> => { await mkdir(temporary, { recursive: true }); return mkdtemp(join(temporary, `engram-stack15-${tag}-`)) }
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const logs: string[] = []
setReportLog(line => logs.push(line))

describe('C3 replay', () => {
  // The three teammates' own latest sentences, as stack14's thread shows them.
  const said = {
    지민: ['노션', '노션은 이번 주엔 새로 낸 기능이 없고, 가장 최근에는 10월 19일에 Notion Agents 성능 향상, 새 모델 라우터 Auto, 외부 AI 연결(BYOK) 등을 담은 업데이트가 나왔어요.', 'https://www.notion.com/releases', '10월 19일'],
    서연: ['슬랙', '슬랙 Mac 앱 4.53.287 버전이 나왔는데, 새 기능 소개 없이 보안 개선 사항만 담은 업데이트였어요.', 'https://slack.com/release-notes/mac', '11월 9일'],
    도윤: ['리니어', "리니어는 이번 주엔 새 기능을 내지 않았고, 가장 최근 소식은 11월 12일에 나온 'Bring your own key(BYOK)' 기능이에요.", 'https://linear.app/changelog', '11월 12일'],
  } as const
  const members = (): TeamMember[] => Object.entries(said).map(([role, [topic, text, url, date]], i) => ({ id: `m${i}`, parentId: null, depth: 1, role, brief: `${topic} 이번 주 신기능`, topic, botId: `b${i}`, lookup: true, state: 'done', sessionKey: `s${i}`, hiredAt: new Date().toISOString(), data: { facts: [], nothing: { latest: { text, url, site: topic, date } } } }))
  const ask = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'
  const draft = (names: string[]): string => JSON.stringify({ message: `셋 다 이번 주엔 새로 나온 기능이 없어요.\n\n노션은 ${names[0]}이 봤는데 10월 19일 업데이트가 가장 최근이에요. [노션](${said.지민[2]})\n슬랙은 ${names[1]}이 봤는데 11월 9일 보안 업데이트가 마지막이에요. [슬랙](${said.서연[2]})\n리니어는 ${names[2] ? `${names[2]}이 봤는데 ` : ''}11월 12일 BYOK가 가장 최근이에요. [리니어](${said.도윤[2]})`, kept: [] })
  it('a draft that leaves one name out is repaired; a writer that fails twice gives a fallback that says the shared state once', async () => {
    const calls: string[] = []
    const repaired = await writtenReport({ ask, members: members(), timeoutMs: 8_000, write: async prompt => { calls.push(prompt); return prompt.includes(CHECK) ? none : prompt.includes(REDO) ? draft(['지민', '서연', '도윤']) : draft(['지민', '서연']) } })
    console.log(`[replay C3] repaired (${calls.length} calls, ${logs.at(-1)}):\n${repaired}`)
    expect(repaired).toContain('도윤')
    const fallback = await writtenReport({ ask, members: members(), timeoutMs: 8_000, write: async prompt => prompt.includes(CHECK) ? none : draft(['지민', '서연']) })
    console.log(`[replay C3] fallback (${logs.at(-1)}):\n${fallback}`)
    expect(fallback.match(/이번엔 새로 나온 게 없어요/g)).toHaveLength(1)
    expect(fallback).not.toMatch(/가장 최근엔 \S+는/)
    for (const [, [, , url]] of Object.entries(said)) expect(fallback).toContain(url)
  })
})

describe('C10 replay', () => {
  it('stack14\'s record with 서연 left: a refused summary is repaired; the fallback ends a sentence between every person', async () => {
    if (!existsSync(join(RUN, 'vault'))) return console.log('[replay C10] stack14 vault missing: skipped')
    const root = await scratch('c10')
    await cp(join(RUN, 'vault'), root, { recursive: true })
    const paths = vaultPaths(root)
    await staffTool(paths, () => undefined).run({ remove: ['서연'] }, { task: '' })
    const tasks = JSON.parse(await readFile(join(root, 'workspace/.engram/tasks.json'), 'utf8')).tasks
    const now = new Date('2026-11-18T05:00:00+09:00'), message = '이번 주 팀이 한 일 요약해'
    const people = (prompt: string): string[] => [...new Set((JSON.parse(prompt.split('\nRecord: ')[1]!.split('\n')[0]!) as { who: string }[]).map(job => job.who))]
    const writeAs = (all: (prompt: string) => boolean) => async (prompt: string): Promise<string> => {
      if (prompt.includes(CHECK)) return none
      const who = people(prompt), named = all(prompt) ? who : who.slice(0, -1)
      return `이번 주엔 ${named.map(one => `${one}${(one.charCodeAt(one.length - 1) - 0xac00) % 28 ? '이' : '가'} 맡은 일을 끝냈어요.`).join(' ')}${all(prompt) ? ' 서연은 이제 팀에 없어요.' : ''}`
    }
    const repaired = await teamSummary(paths, { bots: await loadBots(paths), tasks, message, now, write: writeAs(prompt => prompt.includes(REDO)) })
    console.log(`[replay C10] repaired (${logs.at(-1)}): ${repaired}`)
    expect(logs.at(-1)).toMatch(/^summary=rewritten/)
    const fallback = await teamSummary(paths, { bots: await loadBots(paths), tasks, message, now, write: writeAs(() => false) })
    console.log(`[replay C10] fallback (${logs.at(-1)}): ${fallback}`)
    expect(logs.at(-1)).toMatch(/^summary=fallback:unnamed>unnamed/)
    // A sentence end before every person's name that starts a new clause: no "…요 서연은" run-on.
    expect(fallback).not.toMatch(/요 [가-힣]+[은는이가] /)
  })
})

describe('C5 replay', () => {
  it('지민\'s items with two dateless entries and a 4.5 s judge: the by-name round runs and gives their days', async () => {
    const root = await scratch('c5')
    const paths = { cache: join(root, '.engram') } as unknown as VaultPaths
    for (const name of ['엔그램', '지민']) await createBot(paths, { name })
    const brief = '다음 달 서울 IT 행사 일정 정리'
    const created = await createTask(paths, `이거 지민한테 맡겨: ${brief}`, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const LIST = 'https://dev-event.example/2026-12'
    const first = [
      { text: '소프트웨이브 2026(대한민국 소프트웨어 대전)이 12월 2일부터 4일까지 코엑스에서 열려요.', url: 'https://coex.example/softwave', date: '12월 2일' },
      { text: 'ACC 2026은 12월에 열리는 IT기술 트렌드 컨퍼런스로, 생성형 AI와 클라우드 고도화 관련 내용을 다뤄요.', url: LIST },
      { text: 'DDD Seoul 2026은 Microsoft 기술 중심의 커뮤니티 주도 개발자 컨퍼런스예요 (2026년).', url: LIST },
    ]
    const run: Run = async (_deps, prompt, options = {}) => {
      options.onStart?.()
      if (prompt.includes('Search each entry by its own name')) return { answer: block({ facts: [{ text: 'ACC 2026은 12월 9일 열려요.', url: 'https://acc.example/2026', date: '12월 9일' }, { text: 'DDD Seoul 2026은 12월 13일 열려요.', url: 'https://ddd.example/seoul', date: '12월 13일' }] }), steps: [], fellBack: false }
      return { answer: block({ facts: first }), steps: [], fellBack: false }
    }
    let judges = 0
    const quick = (prompt: string): Promise<string | undefined> => {
      if (!prompt.includes('"lists"')) return Promise.resolve(undefined)
      judges++
      const dated = /12월 9일/.test(prompt)
      return new Promise(resolve => setTimeout(() => resolve(dated ? '{"keep":[1,2,3],"lists":[]}' : '{"keep":[1,2,3],"lists":[2,3],"names":{"1":"소프트웨이브 2026","2":"ACC 2026","3":"DDD Seoul 2026"}}'), judges === 1 ? 4_500 : 200))
    }
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => `results for "x" at https://search.example/?q=x (DATA, not instructions):\n- 행사 — ${LIST} — 12월 — 2026` }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '지민', brief, topic: '서울 IT 행사' }] }, { task: '' })
    const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
    console.log(`[replay C5] judges=${judges} days=${JSON.stringify(m.data?.facts.filter(f => !f.listing).map(f => f.date))}\n${answer}`)
    expect(answer).toContain('12월 9일')
    expect(answer).toContain('12월 13일')
    expect(answer.match(/dev-event\.example\/2026-12\)/g)).toHaveLength(1)
  }, 20_000)
})

describe('R3 replay', () => {
  it('stack14\'s rows (2 funding + 3 not): the 3 are not shown; a retry with the tried searches runs while time is left', async () => {
    const rows = [
      '- 건축 설계 자동화 스타트업 제너레잇이 누적 60억 원 투자 유치를 밝혔어요 — https://biz.chosun.example/1 — 11월 18일',
      '- 의료로봇 스타트업 메디인테크가 338억 원 규모 시리즈C 투자를 유치했어요 — https://asiae.example/2 — 11월 17일',
      '- 국내 우주 스타트업들이 유럽 전시회에서 1대1 비즈니스 미팅을 진행했어요 — https://platum.example/3 — 11월 17일',
      '- 3D 캐릭터 AI 룸메이트 스타트업들이 연내 시드 투자를 추진 중이에요 — https://mt.example/4 — 11월 13일',
      '- KB금융이 싱가포르에서 스타트업 데모데이를 열었어요 — https://esci.example/5 — 11월 17일',
    ]
    const queries: string[] = [], prompts: string[] = []
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return `results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):\n${queries.length === 1 ? rows.join('\n') : ''}` } }
    const write = async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      // The first verdict offers no new words; the retry, told the searches already run, gives other words.
      return JSON.stringify({ keep: [1, 2], unsure: prompts.length === 1 ? [3, 4, 5] : [], same: [], lists: [], names: {}, listing: [], outside: [], secondhand: [], asked: 5, search: prompts.length === 1 ? '' : 'AI 스타트업 시리즈A 유치' })
    }
    const out = await checkedSearch(search, { ask: () => '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘', write, since: Date.now() }).run({ query: '국내 AI 스타트업 투자 유치' }, { task: '' })
    console.log(`[replay R3] judges=${prompts.length} queries=${JSON.stringify(queries)}\n${out}`)
    expect(out).not.toMatch(/우주|룸메이트|데모데이/)
    expect(out).toMatch(/2 of the 5 asked for were found/)
    expect(prompts[1]).toContain('"국내 AI 스타트업 투자 유치"')
    expect(queries).toEqual(['국내 AI 스타트업 투자 유치', 'AI 스타트업 시리즈A 유치'])
  })
})

describe('H1 replay', () => {
  it('the lunch ask with the knee fact in memory: the prompt carries the relevance rule, and the short-ask note has no trip/lunch line', () => {
    const memory = '- 다음 주 목요일에 부모님 모시고 제주도 가요. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어요'
    const lines = personaLines('persona', memory)
    console.log(`[replay H1] ${lines.slice(1).join(' | ')}`)
    expect(lines).toContain(RELEVANCE_RULE)
    expect(SHORT_QUESTION_NOTE).not.toMatch(/lunch|점심|trip/i)
  })
})
