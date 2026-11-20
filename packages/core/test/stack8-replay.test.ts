import { expect, test } from 'vitest'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import { createBot } from '../src/bots.js'
import { assignTool, employeesAnswer, handBacks, partOutcome, type AssignHost } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const member = (id: string, role: string, brief: string, result: string, topic?: string): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, ...(topic ? { topic } : {}), lookup: true, state: 'released', sessionKey: `s-${id}`, hiredAt: '2026-11-17T04:21:10.414Z', result, review: { ok: true, note: 'auto' } }) as TeamMember
interface Back { added?: string[]; reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (text: string | undefined): Back => JSON.parse(text!) as Back
const count = (text: string, piece: string): number => text.split(piece).length - 1

test('C3 → k1: a teammate who found nothing new this week hands back their own sentence and link, in their place, and saying so is the writer\'s rule', () => {
  const parts = [
    member('m1', '가람', '이번 주 시립도서관 새 소식 찾아봐줘', '이번 주엔 새 공지가 없어요. 가장 최근은 10월 28일 열람실 연장 운영 안내예요. [시립도서관](https://lib.example.kr/notice/412)', '시립도서관'),
    member('m2', '나은', '이번 주 구립도서관 새 소식 찾아봐줘', '이번 주에 올라온 건 없고, 11월 2일 어린이 책 잔치 후기가 마지막이에요. [구립도서관](https://gu-lib.example.kr/news/88)', '구립도서관'),
    member('m3', '다솔', '이번 주 대학도서관 새 소식 찾아봐줘', '새 소식은 못 찾았어요. 지난달 휴관일 안내만 있어요. [대학도서관](https://univ-lib.example.kr/board/7)', '대학도서관'),
  ]
  const out = back(handBacks(parts))
  expect(out.reports.map(r => [r.who, r.part, r.result])).toEqual(parts.map(m => [m.role, m.topic, m.result]))
  expect(out.reports.every(r => r.state === 'done')).toBe(true)
  expect(count(JSON.stringify(out.reports), '](https://')).toBe(3)
  expect(parts.map(partOutcome)).toEqual(['found', 'found', 'found'])
  expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
})

test('R2 → k1: assign with wait hands the lead each teammate\'s price and date lines exactly as written, with the pages read, and does not close the turn', async () => {
  const paths = await initVault(await tmpVaultRoot('stack8-assign'), { git: false })
  const lead = await createBot(paths, { name: '엔그램' })
  const task = { id: 't1', goal: '제과 기계 가격 비교', botId: lead.id, state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const answers: Record<string, [string, string]> = {
    하늘: ['가격: 데크 오븐 3단 기준 412만 원 — https://blog.naver.com/bakeshop/2201\n출시일: 3단은 이미 판매 중, 4단은 내년 봄 예상 — https://www.youtube.com/watch?v=oven3', 'https://blog.naver.com/bakeshop/2201'],
    바다: ['가격: 미발표, 이전 모델 스파이럴 반죽기 1,280,000원 — https://smartstore.naver.com/main/products/5512\n출시일: 미발표, 내년 2월 공개설 — https://cafe.naver.com/doughclub/91', 'https://smartstore.naver.com/main/products/5512'],
    마루: ['가격: 발효기 2도어 96만 원 — https://proof.example.kr/p2\n출시일: 2026년 9월 14일 정식 출시 — https://proof.example.kr/p2', 'https://proof.example.kr/p2'],
  }
  const host: AssignHost = {
    self: null, load: async () => task, change: async work => work(task),
    run: async ids => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) settleMember(m, { answer: answers[m.role]![0], sources: [answers[m.role]![1]] }, '2026-11-17T05:00:00.000Z', true) },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 100_000, personSaid: () => '', later: async () => undefined, attach: async () => false,
  }
  const tool = assignTool(paths, host, () => undefined)
  const out = back(await tool.run({ wait: true, to: [{ who: '하늘', brief: '데크 오븐 가격과 출시일 조사', topic: '데크 오븐' }, { who: '바다', brief: '스파이럴 반죽기 가격과 출시일 조사', topic: '반죽기' }, { who: '마루', brief: '발효기 가격과 출시일 조사', topic: '발효기' }] }, { task: '' }))
  expect(out.reports.map(r => [r.who, r.part, r.result])).toEqual([['하늘', '데크 오븐', answers['하늘']![0]], ['바다', '반죽기', answers['바다']![0]], ['마루', '발효기', answers['마루']![0]]])
  expect(out.reports.map(r => r.sources)).toEqual([[answers['하늘']![1]], [answers['바다']![1]], [answers['마루']![1]]])
  expect(out.added).toEqual(['하늘·바다·마루는 새로 넣었어요.'])
  expect(out.note).toContain('never a site name alone')
  expect(out.note).toContain('Give the person ONE merged answer in their language')
  const closes = tool.closes as (args: Record<string, unknown>) => boolean
  expect([closes({ wait: true }), closes({ wait: false })]).toEqual([false, true])
})

test('C3 (c8b run) → k1: when every teammate says nothing new was found, the lead is given exactly those words to write from, and nothing is produced without a hand-back', () => {
  const words = ['이번 주 등산 모임 새 일정은 없어요. 10월 19일 억새 산행이 마지막이었어요. https://hike.example.kr/plan/1019', '둘레길 모임도 이번 주엔 새로 올라온 게 없어요. https://trail.example.kr/list', '암벽 모임은 새 소식을 못 찾았어요.']
  const members = words.map((result, i) => ({ ...member(`m${i + 1}`, ['가람', '나은', '다솔'][i]!, `이번 주 ${['등산', '둘레길', '암벽'][i]} 모임 새 일정 조사`, result, ['등산', '둘레길', '암벽'][i]), botId: `bot-${i}`, background: true as const, state: 'done' as const }))
  const task = { id: 't', goal: '이번 주 모임 세 곳 새 일정 알아봐', botId: 'lead', state: 'waiting', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members, hires: 3, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  const out = back(employeesAnswer(task))
  expect(out.reports.map(r => r.result)).toEqual(words)
  expect(out.reports.map(r => r.who)).toEqual(['가람', '나은', '다솔'])
  expect(out.note).toContain('Say plainly which part failed or is missing.')
  expect(employeesAnswer(undefined)).toBeUndefined()
  expect(employeesAnswer({ ...task, team: { ...task.team!, members: [] } })).toBeUndefined()
})

test('C5 (c8b run) → k1: an item that ends on its link\'s own name is handed back once, as written, and the pages read are listed beside it, not written into it again', () => {
  const answer = '12월 3일~5일 겨울 빵 박람회, 킨텍스 [킨텍스](https://www.kintex.example/event/3)\n12월 11일 제과 기능 경연, 양재 aT센터 [aT센터](https://at.example.kr/2026)'
  const m: TeamMember = { ...member('m1', '가람', '다음 달 수도권 제빵 박람회 날짜 모으기', ''), state: 'working' }
  delete m.result
  settleMember(m, { answer, sources: ['https://www.kintex.example/event/3', 'https://at.example.kr/2026'] }, '2026-11-17T05:00:00.000Z', true)
  expect(m.result).toBe(answer)
  const out = back(handBacks([m]))
  expect(out.reports[0]!.result).toBe(answer)
  expect(count(out.reports[0]!.result, '](https://')).toBe(2)
  expect(count(out.reports[0]!.result, '킨텍스 [킨텍스]')).toBe(1)
  expect(out.reports[0]!.sources).toEqual(['https://www.kintex.example/event/3', 'https://at.example.kr/2026'])
})
