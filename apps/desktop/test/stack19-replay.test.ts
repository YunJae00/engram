import { describe, expect, it, vi } from 'vitest'
import { handBacks, keepRead, keepSources, partOutcome, runToolSession, skipWalls, timeBoxed, type AgentTool, type TeamMember } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import * as desk from '../src/main/desk-lane.js'
import { answerBubbles, answerReplies } from '../src/renderer/src/markdown.js'

const fns = (mod: object): string[] => Object.entries(mod).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const DESK_FNS = ['fixSlideTitle', 'keepAsk', 'keptFix', 'kindSortAsk', 'plainKeep', 'slideTitleFix', 'sortByKind']
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const handed = (members: TeamMember[], added: string[] = []): { added?: string[]; reports: Report[]; note: string } => JSON.parse(handBacks(members, added)) as { added?: string[]; reports: Report[]; note: string }
const lead = async (draft: string, ask: string): Promise<{ answer: string; quick: number }> => {
  let quick = 0
  const out = await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }), quick: async () => { quick++; return '' } } as never, workdir: '/x', tools: [] }, ask, {})
  return { answer: out.answer, quick }
}
const at = new Date().toISOString()
const helper = (id: string, role: string, said: string, sources: string[], topic = `${role} 날씨`): TeamMember => ({ id, parentId: null, depth: 1, role, topic, brief: `${role}의 오늘 날씨 조사`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s-${id}`, hiredAt: at, said, sources, result: said })
const NAVER = (q: string): string => `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`

describe('stack-19 replay T1 (cleanup run, tasks.json t-mwm6fgpt): four found helpers, 대구 added mid-work', () => {
  const members = [
    helper('h1', '서울', `오늘 서울 날씨: 흐림, 현재 온도 3.7°(체감 0.9°), 강수는 없음 (출처: ${NAVER('서울 날씨')})`, [NAVER('서울 날씨')]),
    helper('h2', '부산', `부산 오늘(11월 18일) 날씨: 구름많음, 현재 온도 10.0°(체감 8.3°), 강수는 없어요 — [네이버 날씨](${NAVER('부산 날씨')})`, [NAVER('부산 날씨')]),
    helper('h3', '제주', `날씨: 흐림, 현재 온도 10.0°(어제보다 3.8° 낮음), 체감 7.3°, 강수 없음(현재는 비 안 오고 저녁부터 비 예보) — [네이버 날씨](${NAVER('제주 날씨')})`, [NAVER('제주 날씨')]),
    helper('h4', '대구', '낮 기온은 7도로 종일 쌀쌀하겠습니다. (https://news.kbs.co.kr/news/pc/view/view.do?ncd=8716254&ref=A)', [NAVER('대구 날씨')]),
  ]
  it.each([['with nothing said as added', []], ['with 대구 said as added mid-work', ['대구 날씨 조사는 새로 넣었어요.']]] as const)('%s: one hand-back with all four cities, each in its own words, and no "못 찾았어요"', (_what, added) => {
    const out = handed(members, [...added])
    console.log(`stack-19 replay T1 (${_what}):\n${out.reports.map(one => one.result).join('\n')}`)
    expect(out.reports.map(one => one.who)).toEqual(['서울', '부산', '제주', '대구'])
    expect(out.reports.map(one => one.result)).toEqual(members.map(m => m.result))
    expect(out.added).toEqual(added.length ? [...added] : undefined)
    expect(members.map(partOutcome)).toEqual(['found', 'found', 'found', 'found'])
    expect(out.reports[0]!.result).toContain('3.7')
    expect(out.reports[3]!.result).toContain('7도')
    expect(JSON.stringify(out.reports)).not.toContain('못 찾았어요')
  })
})

describe('stack-19 replay R2 shape: three found helpers, the writer late', () => {
  const S = { iphone: 'https://apple.example/iphone18', galaxy: 'https://news.example/galaxy-s27', pixel: 'https://store.example/pixel11' }
  const members = [
    helper('p1', 'iphone18', `아이폰 18은 출고가 125만 원부터, 9월 19일 출시예요. [애플](${S.iphone})`, [S.iphone], '아이폰 18'),
    helper('p2', 'galaxyS27', `갤럭시 S27은 아직 발표 전이고, 예상가는 120만 원대, 내년 2월 출시 예상이에요. [뉴스](${S.galaxy})`, [S.galaxy], '갤럭시 S27'),
    helper('p3', 'pixel11', `픽셀 11은 799달러부터, 8월 28일 출시예요. [구글 스토어](${S.pixel})`, [S.pixel], '픽셀 11'),
  ]
  it('no host writer is waited for: each helper\'s own sentence with its link is handed to the lead at once; no "못 찾았어요"', () => {
    const began = Date.now(), out = handed(members)
    console.log(`stack-19 replay R2:\n${out.reports.map(one => one.result).join('\n')}`)
    expect(Date.now() - began).toBeLessThan(300)
    expect(out.reports.map(one => one.part)).toEqual(['아이폰 18', '갤럭시 S27', '픽셀 11'])
    for (const [i, text, url] of [[0, '125만 원', S.iphone], [1, '120만 원대', S.galaxy], [2, '799달러', S.pixel]] as const) { expect(out.reports[i]!.result).toContain(text); expect(out.reports[i]!.result).toContain(url); expect(out.reports[i]!.sources).toEqual([url]) }
    expect(JSON.stringify(out.reports)).not.toContain('못 찾았어요')
    expect(Object.keys(out)).toEqual(['reports', 'note'])
  })
})

describe('stack-19 replay R3/H6 shape: as many sure in-period rows as asked', () => {
  it.each([5, 3])('%i asked, %i in-period rows: all go to the reader, no extra search, no short-count line', async n => {
    let searches = 0
    const rows = Array.from({ length: n }, (_, i) => `- AI 스타트업 ${i + 1}호 투자 유치 — https://news.example/ai-${i + 1} — 시리즈A ${i + 10}억 원 — 11월 ${10 + i}일`)
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { searches++; return [`results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):`, `The first ${n} are from the last 30 days.`, ...rows].join('\n') } }
    const ask = `요즘 국내 AI 스타트업 투자 뉴스 ${n}개만 찾아줘`
    const kept: string[] = []
    const wrapped = timeBoxed(keepRead(keepSources(skipWalls(search), new Set<string>()), kept), () => 28_000)
    const out = await wrapped.run({ query: 'AI 스타트업 투자' }, { task: ask })
    expect(searches).toBe(1)
    for (let i = 1; i <= n; i++) expect(out).toContain(`https://news.example/ai-${i}`)
    expect(out.split('\n').slice(2)).toEqual(rows)
    expect(kept).toHaveLength(1)
    expect(out).not.toMatch(/there is no time to look further/)
  })
})

describe('stack-19 replay C6 (cleanup run, tasks.json t-mwm6ixkg): the writer\'s lead stays first, the made-from fact once', () => {
  const items = ['12월 2일부터 4일까지 코엑스에서 열리는 소프트웨이브 2026, 입장료 무료! 일반 참관객이라면 3일이나 4일 방문을 추천해요.', '생성형 AI와 클라우드 트렌드가 궁금하다면, 12월 서울에서 열리는 ACC 2026 IT 컨퍼런스를 놓치지 마세요.', '네이버클라우드가 12월 서울 중구에서 진행하는 AI Expert 공인교육, 지금 관심 있다면 확인해보세요.']
  const brief = '홍보 문구 3개 뽑기\n\nHanded over by 지민 (their job: 다음 달 서울 IT 행사 일정 정리). Work from this result, and keep the facts you use from it as they are:\n소프트웨이브 2026이 12월 2일부터 4일까지 코엑스에서 열려요. — https://www.coex.co.kr/sw2026/\nACC 2026 행사가 12월에 서울에서 열려요. — https://itsight.zdnet.co.kr/acc2026/main.html'
  const seoyeon: TeamMember = { id: 'c6', parentId: null, depth: 1, role: '서연', topic: '초대 글귀', brief, botId: 'bot-seo', writer: true, state: 'done', sessionKey: 's-c6', hiredAt: at, result: items.join('\n') }
  it('nothing is moved, and no host made-from sentence is added', async () => {
    expect(handed([seoyeon]).reports).toEqual([{ who: '서연', part: '초대 글귀', state: 'done', result: items.join('\n') }])
    const first = '서연이 지민이 찾은 행사로 글귀 세 줄을 썼어요.'
    const draft = [first, ...items.map((item, i) => `${i + 1}. ${item}`), '[코엑스](https://www.coex.co.kr/sw2026/) · [지디넷코리아](https://itsight.zdnet.co.kr/acc2026/main.html)'].join('\n')
    const out = await lead(draft, '지민이 찾은 걸 서연이 받아서 글귀 세 줄 쓰게 해')
    console.log(`stack-19 replay C6:\n${out.answer}`)
    expect(out).toEqual({ answer: draft, quick: 0 })
    expect(out.answer.split('\n')[0]).toBe(first)
    expect(out.answer.split('지민이').length - 1).toBe(1)
  })
})

describe('stack-19 replay H2/H3: a repaired desk answer keeps its replies block, no empty box', () => {
  const line = '11월 매출 합계는 2,764,000원이에요.'
  it.each([[['10월 걸로도 알려줘', '월별로 나눠줘']], [['표로 보여줘']], [['작년 11월이랑 비교해줘', '엑셀로 뽑아줘', '차트로 그려줘']]])('the answer with its replies block %j is posted whole: the block is read as replies and leaves no bubble of its own', async replies => {
    const block = ['```replies', ...replies, '```'].join('\n'), draft = `${line}\n\n${block}`
    const out = await lead(draft, '12월 아니고 11월 것으로')
    expect(out).toEqual({ answer: draft, quick: 0 })
    expect(out.answer).toContain(block)
    expect(answerReplies(out.answer)).toEqual(replies)
    expect(answerBubbles(out.answer)).toEqual([line])
    expect(fns(desk)).toEqual(DESK_FNS)
  })
})

describe('stack-19 replay Q4: the short draft goes out in two quick calls', () => {
  it('"바로 앞 답 절반 길이로" after the meeting apology line: the shorter line is the model\'s one step and goes out as written, with no quick call at all', async () => {
    const out = await lead('Sorry I was late to the meeting.', '바로 앞 답 절반 길이로')
    expect(out).toEqual({ answer: 'Sorry I was late to the meeting.', quick: 0 })
    expect(fns(desk)).toEqual(DESK_FNS)
  })
})
