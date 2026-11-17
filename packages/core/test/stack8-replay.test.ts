import { expect, test, vi } from 'vitest'
import { mergedReport, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'

// stack-8 section 3: the stored results of stack7-b3ddda26 (tasks.json), fed through the host's merge. Each teammate came back with their
// own sentence and a link, and the thread read three "… 쪽은 이번엔 못 찾았어요." lines under "셋 다 찾아봤어요." (C3).
const member = (id: string, role: string, brief: string, result: string, topic?: string): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, ...(topic ? { topic } : {}), lookup: true, state: 'released', sessionKey: `s-${id}`, hiredAt: '2026-11-17T04:21:10.414Z', result, review: { ok: true, note: 'auto' } }) as TeamMember
const now = new Date('2026-11-17T04:21:23.813Z')

test('C3: a teammate who found nothing new this week keeps their own sentence and link, and the lead says nothing is new', () => {
  const out = mergedReport([
    member('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', '이번 주(11/16~11/22) 기간에 해당하는 노션 공식 신기능 발표는 검색 결과에 나오지 않았어요. 가장 최근으로 확인되는 건 2026년 1월 20일자 캘린더·일정 관리 신기능(AI·캘린더 업데이트)이고, 출처 — https://blog.naver.com/airang_checkin/224398073903 에서 확인했어요.\n\n---', '노션'),
    member('m2', '서연', '이번 주 슬랙 신기능 조사해서 알려줘', "이번 주(11/16~11/22) 슬랙 신기능은 검색 결과에 안 나오더라고요! 가장 최근 관련 소식은 11월 16일자로, 챗GPT가 슬랙·지메일·노션 연동 앱의 글을 참고해 사용자 말투를 따라 쓰는 '라이팅 스타일' 기능 소식이었는데, 이건 슬랙 자체 신기능이 아니라 챗GPT 쪽 기능이더라고요.\nhttps://www.wikitree.co.kr/articles/1157905", '슬랙'),
    member('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', '이번 주(11/16~11/22) 리니어 신기능 관련 자료는 찾지 못했네요. 가장 최근에 확인된 건 리니어 대안/경쟁사 비교 글 정도였어요(2025년 기준, 신기능 발표 아님) — https://clickup.com/ko/blog/67806/linear-alternatives', '리니어'),
  ], new Map(), [], { ask: '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', now })
  expect(out).not.toMatch(/찾아봤어요|못 찾았어요|출처 —/)
  expect(out.split('\n')[0]).toBe('이번 주엔 셋 다 새로 낸 게 없어요. 가장 최근 것만 적었어요.')
  for (const words of ['1월 20일', '라이팅 스타일', '경쟁사 비교 글']) expect(out).toContain(words)
  expect(out.match(/\]\(https:\/\//g)).toHaveLength(3)
})

test('R2: price and date lines keep no empty "(출처: )", no "… — 출처" tail and no "결과를 보고드려요" opener; three links on three hosts', () => {
  const out = mergedReport([
    member('m1', '아이폰18', '아이폰 18의 가격과 출시일을 조사해줘.', '가격: 아이폰18 프로 256GB 기준 199만원 (출처: 출처 https://blog.naver.com/cnpabc123/224479926970), 아이폰18 일반형은 미발표, 내년 봄 출시 예상 (출처: https://www.youtube.com/watch?v=s3wLAIMQpPs)\n출시일: 아이폰18 프로는 이미 출시됨, 일반형은 2027년 봄 예상 (출처: https://www.youtube.com/watch?v=s3wLAIMQpPs).'),
    member('m2', '갤럭시S27', '갤럭시 S27의 가격과 출시일을 조사해줘.', '갤럭시 S27 가격과 출시일 조사 결과를 보고드려요.\n\n가격: 미발표, 전작 S26 1,045,000원 — 출처(https://smartstore.naver.com/main/products/13734664121)\n출시일: 미발표, 2027년 1~2월 공개설 (국내는 내년 상반기 출시 전망) — 출처(https://blog.naver.com/yongyongvvv/224479063208)'),
    member('m3', '픽셀11', '픽셀 11의 가격과 출시일을 조사해줘.', '가격: 출시 당시 가격 체계가 전작보다 인상됨 — [Yellow](https://yellow.com/ko/news/pixel-11)\n출시일: 2026년 8월 20일 정식 출시 — 출처'),
  ], new Map(), [], { ask: '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜', now })
  expect(out).not.toMatch(/\(출처[:：]?\s*(출처\s*)?\)|— 출처|보고드려요|[一-鿿぀-ヿ]/u)
  expect(out.split('\n').filter(line => line.startsWith('셋 다'))).toHaveLength(1)
  const hosts = [...out.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(found => new URL(found[1]!).host)
  expect(new Set(hosts).size).toBe(3)
})

test('C3 (c8b run): when every teammate says first that nothing new was found, no writer is asked and the lead says so', async () => {
  const members = [
    member('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', '이번 주(11/16~11/22)엔 노션에서 새로 나온 업데이트는 확인되지 않아요. 가장 최근 소식은 2026년 10월 19일 공개된 AI 에이전트 개편(크레딧 체계 개편, Auto 모델 라우터, 작업 최대 24시간 처리, ChatGPT 요금제 연결)이에요.\n\n출처: https://www.notion.com/releases/2026-10-19', '노션'),
    member('m2', '서연', '이번 주 슬랙 신기능 조사해서 알려줘', '이번 주(11/16~11/22) 슬랙 신기능은 검색에서 못 찾았더라고요! Android용 슬랙 릴리스 노트 쪽은 알림 배너 유지 시간 개선 같은 버그 수정 내용뿐이라 이번 주 신기능이라고 보긴 어렵더라고요.\n\nhttps://slack.com/intl/ko-kr/release-notes/android', '슬랙'),
    member('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', '이번 주(11/16~11/22) 리니어 신기능은 검색 결과로 확인이 안 되네요. 두 번 찾아봤는데 둘 다 관련 없는 내용만 나왔어요.', '리니어'),
  ]
  const write = vi.fn(async () => '리니어만 새 소식이 있어요.')
  const out = await writtenReport({ ask: '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', members, write, now: new Date('2026-11-17T05:29:19.705Z') })
  expect(write).not.toHaveBeenCalled()
  expect(out.split('\n')[0]).toBe('이번 주엔 셋 다 새로 낸 게 없어요. 가장 최근 것만 적었어요.')
  expect(out).toContain('10월 19일')
  expect(out).toContain('버그 수정')
})

test('C5 (c8b run): an item that ends on its link\'s own name does not say the name twice', () => {
  const out = mergedReport([member('m1', '지민', '다음 달 서울 IT 행사 일정 정리', '12월 2일~4일: 소프트웨이브 2026(제11회 대한민국 소프트웨어 대전), 코엑스 https://www.coex.co.kr/event/1\n12월 9일: AI 서밋 서울, 양재 aT센터 https://aisummit.co.kr/2026')], new Map(), [], { ask: '다음 달 서울 IT 행사 일정 정리', now })
  expect(out).not.toMatch(/코엑스 \[코엑스\]|코엑스 코엑스/)
})
