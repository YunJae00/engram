import { expect, it } from 'vitest'
import * as core from '../src/index.js'
import { LOOKUP_RULE, memberPersona, MERGED_SHAPE, NO_LIVE_SOURCE, teamHireTools, type DelegatedTask, type TeamHost, type TeamMember } from '../src/index.js'

const helper = (role: string, brief: string, result: string, sources: string[] = ['https://search.naver.com/search.naver?query=x']): TeamMember =>
  ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-18T00:00:00Z', state: 'released', lookup: true, sources, result })

it('c12b: a helper\'s rule has no tier ban and no fixed "미발표" frame; values are labeled by what and whose they are', () => {
  for (const brief of ['모토로라 레이저 70의 가격과 출시일 조사', '낫싱 폰 4의 가격과 출시일 조사']) {
    const rule = memberPersona(helper('h', brief, ''))
    expect(rule).toContain(LOOKUP_RULE)
    expect(rule).not.toMatch(/프로, 울트라, 플러스|another tier|base model unless|not even in a bracket/)
    expect(rule).not.toMatch(/"미발표[,( ]/)
    expect(rule).toContain('a thing already out has its 출시가 and its date, never "미발표"')
    expect(rule).toContain('names what it belongs to')
    expect(rule).toContain('a price with its currency')
    expect(rule).toContain('A source is named by its site or publication')
  }
  expect(MERGED_SHAPE).toContain('Every concrete value a member reported stays in its row')
  expect(MERGED_SHAPE).toContain('says only what the cells below show')
  expect(MERGED_SHAPE).not.toMatch(/same tier|another tier|"미발표 \(/)
})

interface Handed { members: { role: string; state: string; result: string; sources?: string[] }[]; note: string }
async function hired(helpers: readonly TeamMember[], alive?: (url: string) => Promise<boolean>): Promise<Handed> {
  const task = { id: 't', goal: '가격 비교', botId: 'lead', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const host: TeamHost = {
    self: null, load: async () => task, change: async work => work(task),
    run: async ids => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) { const from = helpers.find(one => one.role === m.role)!; Object.assign(m, { state: 'done', result: from.result, ...(from.sources ? { sources: from.sources } : {}) }) } },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 1_000_000, personSaid: () => '', ...(alive ? { alive } : {}),
  }
  return JSON.parse(await teamHireTools(host)[0]!.run({ members: helpers.map(h => ({ role: h.role, brief: h.brief, lookup: true })) }, { task: '' })) as Handed
}

it('c12b → k1: the lead is handed every value its helpers reported, labeled, for an unreleased base model beside a released upper model and for a released phone, and is told to keep each in its row', async () => {
  const fold = helper('폴드', '갤럭시 Z 폴드 8의 가격과 출시일 조사', '기본형은 아직 미발표예요. 울트라는 지난달 출시됐어요.\n가격: 울트라 출시가 289만 원부터 (https://news.example.kr/fold8-ultra)\n출시일: 기본형 2027년 7월 예상 (https://news.example.kr/fold8)')
  const razr = helper('레이저', '모토로라 레이저 70의 가격과 출시일 조사', '가격: 출시가 129만 원 (https://moto.example.com/razr70)\n출시일: 2026년 6월 5일 (https://moto.example.com/razr70)')
  const out = await hired([fold, razr])
  expect(out.members.map(m => [m.role, m.result])).toEqual([['폴드', fold.result], ['레이저', razr.result]])
  const handed = JSON.stringify(out.members)
  for (const figure of ['289만 원', '2027년 7월', '129만 원', '2026년 6월 5일', 'https://news.example.kr/fold8-ultra', 'https://moto.example.com/razr70']) expect(handed).toContain(figure)
  expect(out.note).toContain('Every concrete value a member reported stays in its row, labeled as the member labeled it')
  expect(out.note).toContain('a thing already out has its 출시가 and date')
})

it('c12b → k1: a page that no longer opens is marked in the helper\'s result before the lead writes, a live page beside it stays, and no link is taken out of the written answer afterwards', async () => {
  const alive = async (url: string): Promise<boolean> => !url.includes('gone.example')
  const kettle = helper('주전자', '전기 주전자 3 가격 조사', '가격: 예상 6만 원 (https://gone.example/kettle3)', ['https://gone.example/kettle3'])
  const toaster = helper('토스터', '토스터 7 가격 조사', '가격: 출시가 9만 원 (https://gone.example/toaster7)\n가격: 출시가 9만 원이에요 (https://toast.example/7)', ['https://gone.example/toaster7', 'https://toast.example/7'])
  const out = await hired([kettle, toaster], alive)
  expect(JSON.stringify(out.members)).not.toContain('gone.example')
  expect(out.members[0]!.result).toBe(`가격: 예상 6만 원 (${NO_LIVE_SOURCE})`)
  expect(out.members[0]!.sources).toBeUndefined()
  expect(out.members[1]!.result).toContain('https://toast.example/7')
  expect(out.members[1]!.sources).toEqual(['https://toast.example/7'])
  expect(out.note).toContain('A value marked "(no live source)" lost the page it was read on')
  for (const gone of ['liveLinks', 'liveCited', 'citeMembers']) expect(Object.keys(core)).not.toContain(gone)
})
