import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { takesCompanyLane } from 'core'
import { deskKind, deskLight, inKoreanWords, plainKeep, slideTitleFix } from '../src/main/desk-lane.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')
const team = { staff: ['지민', '서연', '도윤'], chief: true }

// stack-8 section 1: c8c's host-made slide-title edit and plain memory save act only on their exact shapes, and only when the turn is
// neither a team ask nor a lookup (kind exists only outside both lanes: stack7-lanes pins that line).
it('stack-8: a slide title for a teammate goes to the team lane, and a remember-then-tell is no plain save', () => {
  const toTeammate = '지민한테 3번 슬라이드 제목 바꾸라고 해'
  expect(takesCompanyLane(toTeammate, team)).toBe(true)
  expect(takesCompanyLane('지민한테 3번 슬라이드 제목 바꿔달라고 해', team)).toBe(true)
  // Someone not on the team is no hand-off.
  expect(takesCompanyLane('민호한테 늦는다고 해', team)).toBe(false)
  expect(slideTitleFix(toTeammate)).toBeUndefined()
  expect(slideTitleFix('지민한테 3번 슬라이드 제목 "핵심 지표"로 바꾸라고 해')).toBeUndefined()
  const lookupKeep = '엔비디아 주가 기억해 뒀다가 알려줘'
  expect(plainKeep(lookupKeep)).toBeUndefined()
  expect(deskKind(lookupKeep)).not.toBe('keep')
  expect(deskKind('내 이름은 권윤재야. 기억해')).toBe('keep')
  // The plain shapes still work.
  expect(plainKeep('내 이름은 권윤재고 지민호랑 같이 일해. 기억해')?.fact).toBe('내 이름은 권윤재고 지민호랑 같이 일해')
  expect(slideTitleFix('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toEqual({ slide: 3, title: '핵심 지표' })
  expect(ipc).toContain("const keep = !handed && !fixed && kind === 'keep' ? plainKeep(")
  expect(ipc).toContain("const retitle = !handed && kind === 'deck' ? slideTitleFix(request.message) : undefined")
})

// Light effort (no long thinking) only for small changes: keep, the pre-read note, tidy, and a change to a document that exists. A new
// document, a lookup and a team ask keep the effort they had on b3ddda26 (light is set only inside the desk branch).
it('stack-8: light effort is for small changes only', () => {
  expect(ipc).toContain("...(desk ? { modelHint: 'smart' as const, ...(deskLight(kind, routed, { given: !!given, made: earlierOutputs.some(output => /\\.(pptx|docx|xlsx)$/i.test(output.name)) }) ? { light: true } : {}) } : {}),")
  // stack-10: a reshape of the last reply is written by the quick voice (desk-lane.ts reshapeAsk) and opens no session.
  expect(ipc.match(/light: true/g)).toHaveLength(1)
  for (const ask of ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', '위 회의록으로 워드 보고서 만들어줘', '매출 데이터로 엑셀 표 만들어줘'])
    expect(deskLight(deskKind(ask), ask, { made: true }), ask).toBe(false)
  for (const ask of ['엔비디아 오늘 주가 알려줘', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'])
    expect(deskLight(deskKind(ask), ask, { made: true }), ask).toBe(false)
  // c8c r3 #1: taking something out of a deck is a change to it; deleting stays gated.
  const cut = '그 피피티에서 미결 슬라이드는 빼줘'
  expect(deskKind(cut)).toBe('deck')
  expect(deskLight(deskKind(cut), cut, { made: true })).toBe(true)
  expect(deskKind('그 피피티 파일 지워줘')).not.toBe('deck')
})

it('stack-8 (c8c run D1): a Han shorthand in a note summary is said in Korean words; text with no Hangul is left alone', () => {
  expect(inKoreanWords('신규 온보딩 화면 시안 확정 (B안 선호 의견 多)')).toBe('신규 온보딩 화면 시안 확정 (B안 선호 의견 많음)')
  expect(inKoreanWords('多 and 少')).toBe('多 and 少')
  expect(ipc).toContain("if (kind === 'note' && !result.asked) result.answer = inKoreanWords(result.answer)")
})
