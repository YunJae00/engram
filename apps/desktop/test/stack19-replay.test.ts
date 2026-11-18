import { describe, expect, it, vi } from 'vitest'
import { checkedSearch, helperAnswer, wellFormed, writtenReport, type AgentTool, type TeamMember } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { checkedDesk, reshapeAsk } from '../src/main/desk-lane.js'

const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
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
  const ask = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘\n아 대구도 추가해'
  it.each([['no writer draft', () => ''], ['a draft that leaves 대구 out', (prompt: string) => {
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
    const three = data.filter(p => p.part !== '대구' && p.facts?.length)
    return JSON.stringify({ message: ['오늘 세 도시 모두 비 소식은 없어요.', ...three.map(p => `${p.part}: ${p.facts![0]!.text} ${p.facts![0]!.link}`)].join('\n'), kept: three.map(p => p.facts![0]!.id) })
  }]] as const)('%s: one message with all four cities, each with its own words, and no "못 찾았어요"', async (_what, writer) => {
    const out = (await helperAnswer({ ask, members, since: 0, due: Date.now() + 20_000, write: async prompt => prompt.includes(CHECK) ? '{"problems":[]}' : writer(prompt) }))!
    console.log(`stack-19 replay T1 (${_what}):\n${out}`)
    for (const city of ['서울', '부산', '제주', '대구']) expect(out).toContain(city)
    expect(out).toContain('3.7')
    expect(out).toContain('7도')
    expect(out).not.toContain('못 찾았어요')
  })
})

describe('stack-19 replay R2 shape: three found helpers, the writer late', () => {
  const S = { iphone: 'https://apple.example/iphone18', galaxy: 'https://news.example/galaxy-s27', pixel: 'https://store.example/pixel11' }
  const members = [
    helper('p1', 'iphone18', `아이폰 18은 출고가 125만 원부터, 9월 19일 출시예요. [애플](${S.iphone})`, [S.iphone], '아이폰 18'),
    helper('p2', 'galaxyS27', `갤럭시 S27은 아직 발표 전이고, 예상가는 120만 원대, 내년 2월 출시 예상이에요. [뉴스](${S.galaxy})`, [S.galaxy], '갤럭시 S27'),
    helper('p3', 'pixel11', `픽셀 11은 799달러부터, 8월 28일 출시예요. [구글 스토어](${S.pixel})`, [S.pixel], '픽셀 11'),
  ]
  it('each helper\'s own sentence with its link; no "못 찾았어요"', async () => {
    const out = (await helperAnswer({ ask: '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘', members, since: 0, due: Date.now() + 300, write: () => new Promise(resolve => setTimeout(() => resolve(undefined), 1000)) }))!
    console.log(`stack-19 replay R2:\n${out}`)
    for (const [text, url] of [['125만 원', S.iphone], ['120만 원대', S.galaxy], ['799달러', S.pixel]] as const) { expect(out).toContain(text); expect(out).toContain(url) }
    expect(out).not.toContain('못 찾았어요')
  })
})

describe('stack-19 replay R3/H6 shape: as many sure in-period rows as asked', () => {
  it.each([5, 3])('%i asked, %i in-period rows: all go to the reader, no extra search, no short-count line', async n => {
    let searches = 0
    const rows = Array.from({ length: n }, (_, i) => `- AI 스타트업 ${i + 1}호 투자 유치 — https://news.example/ai-${i + 1} — 시리즈A ${i + 10}억 원 — 11월 ${10 + i}일`)
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { searches++; return [`results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):`, `The first ${n} are from the last 30 days.`, ...rows].join('\n') } }
    const ask = `요즘 국내 AI 스타트업 투자 뉴스 ${n}개만 찾아줘`
    const wrapped = checkedSearch(search, { ask: () => ask, since: Date.now(), write: async () => '{"keep":[1],"search":"다른 말"}' })
    const out = await wrapped.run({ query: 'AI 스타트업 투자' }, { task: ask })
    expect(searches).toBe(1)
    for (let i = 1; i <= n; i++) expect(out).toContain(`https://news.example/ai-${i}`)
    expect(out).not.toMatch(/there is no time to look further/)
  })
})

describe('stack-19 replay C6 (cleanup run, tasks.json t-mwm6ixkg): the writer\'s lead stays first, the made-from fact once', () => {
  const items = ['12월 2일부터 4일까지 코엑스에서 열리는 소프트웨이브 2026, 입장료 무료! 일반 참관객이라면 3일이나 4일 방문을 추천해요.', '생성형 AI와 클라우드 트렌드가 궁금하다면, 12월 서울에서 열리는 ACC 2026 IT 컨퍼런스를 놓치지 마세요.', '네이버클라우드가 12월 서울 중구에서 진행하는 AI Expert 공인교육, 지금 관심 있다면 확인해보세요.']
  const brief = '홍보 문구 3개 뽑기\n\nHanded over by 지민 (their job: 다음 달 서울 IT 행사 일정 정리). Work from this result, and keep the facts you use from it as they are:\n소프트웨이브 2026이 12월 2일부터 4일까지 코엑스에서 열려요. — https://www.coex.co.kr/sw2026/\nACC 2026 행사가 12월에 서울에서 열려요. — https://itsight.zdnet.co.kr/acc2026/main.html'
  const seoyeon: TeamMember = { id: 'c6', parentId: null, depth: 1, role: '서연', topic: '홍보 문구 3개', brief, botId: 'bot-seo', state: 'done', sessionKey: 's-c6', hiredAt: at, data: { facts: [], items, note: '지민이 조사한 세 행사의 사실을 그대로 살려 문구로 만들었어요.' } }
  it('nothing is moved, and no host made-from sentence is added', async () => {
    const lead = '서연이 지민이 찾은 행사로 홍보 문구 3개를 뽑았어요.'
    const draft = [lead, ...items.map((item, i) => `${i + 1}. ${item}`), '[코엑스](https://www.coex.co.kr/sw2026/) · [지디넷코리아](https://itsight.zdnet.co.kr/acc2026/main.html)'].join('\n')
    const out = await writtenReport({ ask: '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', members: [seoyeon], timeoutMs: 15_000, write: async prompt => prompt.includes(CHECK) ? '{"problems":[]}' : JSON.stringify({ message: draft, kept: [] }) })
    console.log(`stack-19 replay C6:\n${out}`)
    expect(out.split('\n')[0]).toBe(lead)
    expect(out.split('지민이').length - 1).toBe(1)
    expect(out).not.toContain('그대로 살려')
  })
})

describe('stack-19 replay H2/H3: a repaired desk answer keeps its replies block, no empty box', () => {
  const BLOCK = ['```replies', '10월 걸로도 알려줘', '월별로 나눠줘', '```'].join('\n')
  const draft = `11월 매출 합계는 2,764,000원이에요.\n\n${BLOCK}`
  it.each(['```replies', '10월 걸로도 알려줘', '```'])('the check quotes %s as "asks" and the repair blanks everything', async quote => {
    const blank = JSON.stringify({ replace: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i + 1), ''])) })
    const out = await checkedDesk({ ask: '아 그거 말고 11월 걸로', draft, source: '', fromSource: false, quick: async p => p.includes(CHECK) ? JSON.stringify({ problems: [{ kind: 'asks', quote, why: '선택지' }] }) : p.includes(REPAIR) ? blank : undefined, since: Date.now() })
    expect(out).toContain(BLOCK)
    expect(wellFormed(out)).toBe(true)
  })
})

describe('stack-19 replay Q4: the short draft goes out in two quick calls', () => {
  it('"방금 말한 거 더 짧게" after the meeting apology line', async () => {
    let calls = 0
    const last = '여기 있어요.\n\nI apologize for being late to the meeting.'
    const quick = async (prompt: string): Promise<string> => { calls++; return prompt.includes(CHECK) ? '{"problems":[]}' : JSON.stringify({ form: 'shorter', was: 'I apologize for being late to the meeting.', reply: 'Sorry I was late to the meeting.' }) }
    expect(await reshapeAsk('방금 말한 거 더 짧게', last, quick, '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘')).toBe('Sorry I was late to the meeting.')
    expect(calls).toBe(2)
  })
})
