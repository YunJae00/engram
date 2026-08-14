import { describe, expect, it } from 'vitest'
import type { NoteDto } from '../src/shared/types.js'
import { deriveTopicLabel, shortTopicLabel } from '../src/renderer/src/lib/topicLabel.js'
import { buildBrain } from '../src/renderer/src/lib/topics.js'

// Topic labels must read like THEMES, not one member's full note title —
// deriveTopicLabel covers the no-hub path, buildBrain proves the hub title
// still wins when a hub fronts the component.

describe('deriveTopicLabel', () => {
  it('a ticket cluster yields the shared phrase, not the lead ticket title', () => {
    const label = deriveTopicLabel('[SATURN-244] 코드 인터프리터 다단계 작업 중단 수정', [
      '[SATURN-244] 코드 인터프리터 다단계 작업 중단 수정',
      '[SATURN-231] 코드 인터프리터 세션 타임아웃 조사',
      '코드 인터프리터 샌드박스 메모리 한도 메모',
    ])
    expect(label).toBe('코드 인터프리터')
  })

  it('joins at most two tokens even when a longer phrase repeats', () => {
    const label = deriveTopicLabel('vault sync conflict resolution design', [
      'vault sync conflict resolution design',
      'vault sync conflict resolution notes',
    ])
    expect(label).toBe('vault sync')
  })

  it('ticket ids, pure numbers and 1-char tokens never become the label', () => {
    const label = deriveTopicLabel('[ENG-12] a 2026 retro', [
      '[ENG-12] a 2026 retro',
      '[ENG-13] b 2026 retro',
    ])
    // Ticket ids, the 1-char tokens and the pure number '2026' are all noise —
    // only 'retro' repeats as a meaningful token.
    expect(label).toBe('retro')
  })

  it('no common token → lead title truncated to ~24 chars with ellipsis', () => {
    const label = deriveTopicLabel('회의록 아키텍처 결정 기록과 후속 액션 아이템 정리', [
      '회의록 아키텍처 결정 기록과 후속 액션 아이템 정리',
      'Standup notes from Tuesday',
    ])
    expect(label).toBe('회의록 아키텍처 결정 기록과 후속 액션 아…')
    expect(label.length).toBeLessThanOrEqual(24)
  })

  it('fallback strips a leading ticket id from the lead title', () => {
    const label = deriveTopicLabel('[SATURN-244] 인터프리터 수정', [
      '[SATURN-244] 인터프리터 수정',
      '완전히 다른 제목',
    ])
    expect(label).toBe('인터프리터 수정')
  })
})

describe('shortTopicLabel (hub titles)', () => {
  it('keeps only the head before a colon — the subtitle is detail, not theme', () => {
    expect(shortTopicLabel('MyClient-ology-be 챗봇 백엔드: 도구 아키텍처 리팩토링과 정확도 개선 종합')).toBe(
      'MyClient-ology-be 챗봇 백엔드',
    )
    expect(shortTopicLabel('ChatX SATURN 개선 스프린트: 채팅 대기 UX·코드 인터프리터 안정화')).toBe(
      'ChatX SATURN 개선 스프린트',
    )
  })

  it('splits on a spaced dash too, and passes short titles through', () => {
    expect(shortTopicLabel('결제 파이프라인 — 장애와 복구의 기록')).toBe('결제 파이프라인')
    expect(shortTopicLabel('ChatX 국제화')).toBe('ChatX 국제화')
  })

  it('a long head without separators truncates to one line', () => {
    const label = shortTopicLabel('아무 구분자 없이 아주 길게 이어지는 서술형 허브 제목의 예시입니다')
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(28)
  })
})

function dto(id: string, title: string, derived_from: string[] = [], type = 'note'): NoteDto {
  return {
    id,
    title,
    status: 'current',
    type,
    decay: 'slow',
    badge: '🟢',
    timeline: 'inferred',
    created: '2026-07-01T00:00:00Z',
    updated: '2026-07-01T00:00:00Z',
    supersedes: [],
    derived_from,
    excerpt: '',
  }
}

describe('buildBrain topic titles', () => {
  it('a hub-fronted cluster uses the hub title HEAD — the subtitle stays out of the label', () => {
    const live = [
      dto('a', '[SATURN-244] 코드 인터프리터 다단계 작업 중단 수정'),
      dto('b', '[SATURN-231] 코드 인터프리터 세션 타임아웃', ['a']),
      dto('c', '코드 인터프리터 샌드박스 메모리 한도', ['a']),
      dto('h', '코드 인터프리터 안정화: 세션·샌드박스·중단 수정 종합', ['a', 'b', 'c'], 'hub'),
    ]
    const brain = buildBrain(live)
    expect(brain.topics).toHaveLength(1)
    expect(brain.topics[0]!.title).toBe('코드 인터프리터 안정화')
    expect(brain.topics[0]!.hub?.id).toBe('h')
  })

  it('a hub-less cluster gets the derived theme, and members keep full titles', () => {
    const live = [
      dto('a', '[SATURN-244] 코드 인터프리터 다단계 작업 중단 수정'),
      dto('b', '[SATURN-231] 코드 인터프리터 세션 타임아웃', ['a']),
      dto('c', '코드 인터프리터 샌드박스 메모리 한도', ['a']),
    ]
    const brain = buildBrain(live)
    expect(brain.topics).toHaveLength(1)
    expect(brain.topics[0]!.title).toBe('코드 인터프리터')
    const titles = brain.topics[0]!.members.map((m) => m.title)
    expect(titles).toContain('[SATURN-244] 코드 인터프리터 다단계 작업 중단 수정')
  })

  // A hub that no longer covers its topic is naming a pile that moved on. The
  // subject that merged the pile speaks until the next sweep re-synthesizes.
  it('a stale hub loses the label to the merged subject', () => {
    const chatbot = [
      'MyClientology BE 챗봇 tool-calling 아키텍처 전환',
      'MyClientology BE 챗봇 다층 가드 도입',
      'MyClientology BE 챗봇 모듈 분해 리팩터링',
      'MyClientology BE: COD 조직 조회 권한 확장',
      'MyClientology 챗봇 파트너 활동 조회',
      'MyClientology BE 사용자 점수 랭킹',
      'GraphRAG v2.6 릴리스',
      'Neo4j v4 스키마 반영',
    ]
    const filters = [
      'MyClientology BE 회사 분류 체계 관리',
      'MyClientology BE: audit/auditor 필드 확장',
      'MyClientology BE 대시보드 필터 및 정렬',
      'MyClientology BE: 회사·감사 필터 확장',
      'MyClientology company 필드 확장 및 remarks 이관',
    ]
    const cliqueIds = (prefix: string, n: number, i: number): string[] =>
      Array.from({ length: n }, (_, k) => `${prefix}${k}`).slice(0, i)
    const live = [
      ...chatbot.map((t, i) => dto(`a${i}`, t, cliqueIds('a', 8, i))),
      ...filters.map((t, i) => dto(`b${i}`, t, [...cliqueIds('b', 5, i), ...(i < 2 ? [`a${i}`] : [])])),
      dto('h', 'MyClientology BE 개발', cliqueIds('a', 8, 8), 'hub'),
    ]
    const brain = buildBrain(live)
    expect(brain.topics).toHaveLength(1)
    expect(brain.topics[0]!.members).toHaveLength(13)
    expect(brain.topics[0]!.title).toBe('MyClientology')
  })
})
