import { describe, expect, it } from 'vitest'
import { mergeBySubject, titleTokens } from '../src/jobs/subject.js'
import { linkComponents } from '../src/jobs/hub.js'
import type { Note } from '../src/schema.js'

type Edge = [string, string]

function adjOf(edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  return adj
}

const clique = (ids: string[]): Edge[] => ids.flatMap((a, i) => ids.slice(i + 1).map((b): Edge => [a, b]))

// A community: ids `${prefix}1..n` carrying the given titles.
function community(prefix: string, titles: string[]): { ids: string[]; titles: Map<string, string> } {
  const ids = titles.map((_, i) => `${prefix}${i + 1}`)
  return { ids, titles: new Map(ids.map((id, i) => [id, titles[i]!])) }
}

// 22 notes in the real vault, 17 of them saying MyClientology.
const MC_CHATBOT = community('a', [
  'MyClientology BE 챗봇 tool-calling 아키텍처 전환',
  'MyClientology BE 챗봇 다층 anti-hallucination 가드 도입',
  'MyClientology BE 챗봇 모듈 분해 대규모 리팩터링',
  'MyClientology BE: COD 조직 조회 권한 확장',
  'MyClientology 챗봇: 파트너 활동 조회 및 해소 개선',
  'MyClientology BE 사용자 점수 랭킹 및 포인트 정책',
  'GraphRAG v2.5 / v2.6 릴리스',
  'Neo4j v4 스키마 반영 및 동기화 모듈 정리',
])
// 9 notes in the real vault, all of them saying MyClientology.
const MC_FILTERS = community('b', [
  'MyClientology BE 회사 분류 체계 관리',
  'MyClientology BE: audit/auditor 필드 확장',
  'MyClientology BE 대시보드 필터 및 정렬',
  'MyClientology BE: 회사·감사 필터 확장',
  'MyClientology company 필드 확장 및 remarks 이관',
])

// Four SATURN clusters. Titles spell the prefix BARE — the ticket filter would
// drop "[SATURN-244]" on its own, and the guard must hold without its help.
const SAT_I18N = community('i', [
  'SATURN 국제화 i18n 적용 완료',
  'SATURN 국제화 누락 전수조사 후속 수정',
  'SATURN 국제화 언어 선택 재활성화',
  'SATURN UI 언어 fallback 규칙 확정',
  'SATURN 딥서치 모드 답변이 질문과 다르게 생성',
])
const SAT_CHAT = community('c', [
  'SATURN 채팅 스트림 정지 시 좀비 세션',
  'SATURN 채팅 대기 중 진행 문구 갱신 안 됨',
  'SATURN 채팅 응답 대기 중 경과 시간 표시',
  'SATURN 채팅 결과 미반영 토큰 회전 불일치',
  'SATURN 채팅 첨부 대용량 파일 한도 초과',
])
const SAT_OAUTH = community('o', [
  'SATURN OAuth 토큰 로그아웃 시 무효화 미흡',
  'SATURN OAuth 로그 추가',
  'SATURN Header 모드 access 토큰 만료 세션 유지',
  'SATURN MCP 서버 연결 기능',
  'SATURN MCP 서버 관리 화면 연결 상태 표시 버그',
])
const SAT_INTERP = community('p', [
  'SATURN 코드 인터프리터 파일 다운로드 404',
  'SATURN 코드 인터프리터 타임아웃 해결',
  'SATURN 코드 인터프리터 다단계 작업 중단',
  'SATURN 코드 인터프리터 생성 파일 다운로드 실패',
  'SATURN 코드 인터프리터 진행 표시 없음',
])

const ALL = [MC_CHATBOT, MC_FILTERS, SAT_I18N, SAT_CHAT, SAT_OAUTH, SAT_INTERP]
const titleOf = (id: string): string => {
  for (const c of ALL) {
    const t = c.titles.get(id)
    if (t !== undefined) return t
  }
  throw new Error(`no title for ${id}`)
}

// Dense inside, a few edges across — exactly the measured shape.
const EDGES: Edge[] = [
  ...ALL.flatMap((c) => clique(c.ids)),
  ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b1'],
  ['i1', 'c1'], ['c1', 'o1'], ['o1', 'p1'], ['i2', 'p2'],
]
const ADJ = adjOf(EDGES)
const COMMUNITIES = ALL.map((c) => c.ids)

const idsOf = (groups: { ids: string[] }[]): string[][] => groups.map((g) => [...g.ids].sort())

describe('mergeBySubject', () => {
  it('merges two dense clusters that are one subject to a person', () => {
    const merged = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const mc = merged.find((g) => g.ids.includes('a1'))!
    expect([...mc.ids].sort()).toEqual([...MC_CHATBOT.ids, ...MC_FILTERS.ids].sort())
    // ...and names it, so the boundary change carries a label with it.
    expect(mc.subject).toBe('MyClientology')
  })

  it('never merges clusters that only share a project prefix', () => {
    const merged = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    expect(merged).toHaveLength(5) // 6 communities, exactly one merge
    for (const cluster of [SAT_I18N, SAT_CHAT, SAT_OAUTH, SAT_INTERP]) {
      const group = merged.find((g) => g.ids.includes(cluster.ids[0]!))!
      expect([...group.ids].sort()).toEqual([...cluster.ids].sort())
      expect(group.subject).toBeNull()
    }
  })

  it('drops ticket tokens, so a shared ticket prefix is not even a candidate', () => {
    expect(titleTokens('[SATURN-244] 코드 인터프리터 다단계 작업 중단')).toEqual([
      '코드',
      '인터프리터',
      '다단계',
      '작업',
      '중단',
    ])
    const ticketed = ALL.map((c) => c.ids)
    const withTickets = (id: string): string =>
      titleOf(id).replace(/^SATURN /, `[SATURN-${id.slice(1)}00] `)
    const merged = mergeBySubject(ticketed, withTickets, ADJ)
    expect(merged).toHaveLength(5)
  })

  it('refuses a subject the link graph does not back — no edge, no merge', () => {
    const isolated = adjOf([...ALL.flatMap((c) => clique(c.ids))])
    const merged = mergeBySubject(COMMUNITIES, titleOf, isolated)
    expect(merged).toHaveLength(6)
    expect(merged.every((g) => g.subject === null)).toBe(true)
  })

  it('refuses a word that only one side is about', () => {
    const half = community('h', [
      'MyClientology BE 챗봇 tool-calling 아키텍처 전환',
      'MyClientology BE 챗봇 다층 가드 도입',
      '스코프 게이트 및 정보 차단',
      '제안 타겟 추천 전용 분석 경로',
      'hard-verify 2-pass 라우터 거짓 매칭 대응',
      'Neo4j v4 스키마 반영',
    ])
    const lookup = (id: string): string => half.titles.get(id) ?? titleOf(id)
    const adj = adjOf([...clique(half.ids), ...clique(MC_FILTERS.ids), ['h1', 'b1']])
    const merged = mergeBySubject([half.ids, MC_FILTERS.ids], lookup, adj)
    expect(merged).toHaveLength(2)
  })

  it('is deterministic — same vault, same topics, whatever order it arrives in', () => {
    const once = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const twice = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const reversed = mergeBySubject([...COMMUNITIES].reverse(), titleOf, ADJ)
    const shuffledMembers = mergeBySubject(
      COMMUNITIES.map((ids) => [...ids].reverse()),
      titleOf,
      ADJ,
    )
    expect(idsOf(twice)).toEqual(idsOf(once))
    expect(idsOf(reversed)).toEqual(idsOf(once))
    expect(idsOf(shuffledMembers)).toEqual(idsOf(once))
    expect(reversed.map((g) => g.subject)).toEqual(once.map((g) => g.subject))
    expect(shuffledMembers.map((g) => g.subject)).toEqual(once.map((g) => g.subject))
  })
})

const NOW = '2026-07-26T00:00:00.000Z'
function noteOf(id: string, title: string, derived: string[]): Note {
  return {
    front: {
      id, type: 'note', status: 'current', supersedes: [], derived_from: derived,
      decay: 'slow', timeline: 'inferred', created: NOW, updated: NOW,
    },
    body: `# ${title}\n\n내용`,
  }
}

describe('linkComponents with the subject merge', () => {
  // Merging BEFORE the size filter is the point: two halves of one subject that
  // each fall under HUB_MIN_NOTES would otherwise both be dropped and the topic
  // would never get a hub at all.
  it('merges two same-subject communities into one topic that earns a hub', () => {
    const notes = [
      ...MC_CHATBOT.ids.map((id, i) =>
        noteOf(id, MC_CHATBOT.titles.get(id)!, MC_CHATBOT.ids.slice(0, i)),
      ),
      ...MC_FILTERS.ids.map((id, i) =>
        noteOf(id, MC_FILTERS.titles.get(id)!, [...MC_FILTERS.ids.slice(0, i), ...(i === 0 ? ['a1'] : [])]),
      ),
    ]
    const topics = linkComponents(notes)
    expect(topics).toHaveLength(1)
    expect(topics[0]!.members).toHaveLength(MC_CHATBOT.ids.length + MC_FILTERS.ids.length)
    expect(topics[0]!.subject).toBe('MyClientology')
  })
})
