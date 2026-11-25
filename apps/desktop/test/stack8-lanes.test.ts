import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runComet, takesCompanyLane, type Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as desk from '../src/main/desk-lane.js'
import { deskKind, deskLight, plainKeep, slideTitleFix } from '../src/main/desk-lane.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')
const team = { staff: ['지민', '서연', '도윤'], chief: true }

it('stack-8: a slide title for a teammate goes to the team lane, and a remember-then-tell is no plain save', () => {
  const toTeammate = '지민한테 3번 슬라이드 제목 바꾸라고 해'
  expect(takesCompanyLane(toTeammate, team)).toBe(true)
  expect(takesCompanyLane('지민한테 3번 슬라이드 제목 바꿔달라고 해', team)).toBe(true)
  expect(takesCompanyLane('민호한테 늦는다고 해', team)).toBe(false)
  expect(slideTitleFix(toTeammate)).toBeUndefined()
  expect(slideTitleFix('지민한테 3번 슬라이드 제목 "핵심 지표"로 바꾸라고 해')).toBeUndefined()
  const lookupKeep = '엔비디아 주가 기억해 뒀다가 알려줘'
  expect(plainKeep(lookupKeep)).toBeUndefined()
  expect(deskKind(lookupKeep)).not.toBe('keep')
  expect(deskKind('내 이름은 권윤재야. 기억해')).toBe('keep')
  expect(plainKeep('내 이름은 권윤재고 지민호랑 같이 일해. 기억해')?.fact).toBe('내 이름은 권윤재고 지민호랑 같이 일해')
  expect(slideTitleFix('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toEqual({ slide: 3, title: '핵심 지표' })
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain("const keep = !fixed && kind === 'keep' ? plainKeep(")
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain("const retitle = kind === 'deck' ? slideTitleFix(message) : undefined")
})

it('stack-8: light effort is for small changes and the team lane\'s own step only', () => {
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain("...(desk ? { modelHint: 'smart' as const, ...(deskLight(kind, routed, { given: !!given, made: earlierOutputs.some(output => /\\.(pptx|docx|xlsx)$/i.test(output.name)) }) ? { light: true } : {}) } : {}),")
  expect(ipc).toContain("...(company ? { modelHint: 'smart' as const, ...(turn?.report ? {} : { light: true }) } : {}),")
  expect(ipc.match(/light: true/g)).toHaveLength(1)
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8').match(/light: true/g)).toHaveLength(1)
  for (const ask of ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', '위 회의록으로 워드 보고서 만들어줘', '매출 데이터로 엑셀 표 만들어줘'])
    expect(deskLight(deskKind(ask), ask, { made: true }), ask).toBe(false)
  for (const ask of ['엔비디아 오늘 주가 알려줘', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'])
    expect(deskLight(deskKind(ask), ask, { made: true }), ask).toBe(false)
  const cut = '그 피피티에서 미결 슬라이드는 빼줘'
  expect(deskKind(cut)).toBe('deck')
  expect(deskLight(deskKind(cut), cut, { made: true })).toBe(true)
  expect(deskKind('그 피피티 파일 지워줘')).not.toBe('deck')
})

it('stack-8 (c8c run D1): a Han shorthand in a note summary is the model\'s to avoid by rule; what it writes is posted as written, shorthand or not', async () => {
  for (const draft of ['신규 온보딩 화면 시안 확정 (B안 선호 의견 多)', '多 and 少']) {
    const result = await runComet({ engine: { id: 'claude', runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, '회의 메모 한 줄로 정리해줘', { guided: false, modelHint: 'smart' })
    expect(result.answer).toBe(draft)
  }
  expect(COLLEAGUE_CORE_RULE).toContain('no Chinese-character shorthand (多, 約, 等)')
  expect(Object.keys(desk).filter(key => typeof (desk as Record<string, unknown>)[key] === 'function').sort()).toEqual(['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind'])
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
})
