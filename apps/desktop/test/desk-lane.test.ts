import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DESK_NOTE, deskLane } from '../src/main/desk-lane.js'
import { fastLane } from '../src/main/fast-lane.js'

// grokbar B7 (stack1-f4f6844c): M1 12.2 s, M2 10.2 s, M3 9.2 s, F2 9.2 s (bar 8), F1 40.7 s (bar 30), D5 34.6 s (bar 30), D3 87.5 s (bar 60),
// each on the work model with 73 tools. These rows' own sentences take the smart tier; work that is not plainly one of them does not.
describe('desk lane', () => {
  it('takes the everyday asks that were slow on the work model', () => {
    for (const ask of [
      '내 이름은 권윤재고 지민호랑 같이 일해. 기억해', '아 지민호 말고 민호야', '나 누구랑 일하지?', '정리한 폴더에 PDF 몇 개야?',
      'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', '방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적',
      'Remember that I work with Minho', 'Organize the files in the inbox folder by type',
    ]) expect(deskLane(ask, true), ask).toBe(true)
  })

  it('leaves everything else, and any turn that is not a plain ask, to the work model', () => {
    for (const ask of [
      'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', '이 계약서 검토해서 위험한 조항 정리한 보고서 작성해줘', '회의록 요약해서 워드로 만들어줘', '경쟁사 분석 자료 조사해서 정리해줘',
      '기억해\n그리고 보고서도 써줘', `기억해 ${'가'.repeat(200)}`, '/plan', '',
    ]) expect(deskLane(ask, true), ask).toBe(false)
    expect(deskLane('나 누구랑 일하지?', false)).toBe(false)
    // A lookup keeps its own lane; the two never both take a turn (ipc.ts: desk = !company && !lane && ...).
    expect(fastLane('엔비디아 오늘 주가 알려줘', true)).toBe(true)
  })

  it('tells the turn to act at once, keep memory silent and end a tidy-up with what went where', () => {
    expect(DESK_NOTE).toContain('without searching memory or notes first')
    expect(DESK_NOTE).toContain('ONE keep_in_mind call (a correction replaces the old fact)')
    expect(DESK_NOTE).toContain('never that it was saved')
    // grokbar cycle 3 F1: a table of all 20 file names cost ~8 s; the answer is the count per kind (rule 6's own example).
    expect(DESK_NOTE).toContain('how many files of each kind were moved')
  })

  it('runs on the smart tier with the shell kept, and a plain kind gets only its own tools', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).toContain('const kind = !company && !lane && deskLane(routed, plainAsk) ? deskKind(routed) : undefined')
    expect(ipc).toContain('const desk = !!kind, deskMenu = kind && DESK_TOOLS[kind]')
    expect(ipc).toContain("...(desk ? { modelHint: 'smart' as const } : {}),")
    expect(ipc).toContain("const deskNote = desk && !short ? DESK_NOTE : ''")
    // The shell is the normal lead's; the menu is the kind's own when it has one (c3c-voice-docs.test.ts), and every tool otherwise.
    expect(ipc).toContain('tools: lane ? everyTool.filter(tool => LANE_TOOLS.has(tool.name))')
    expect(ipc).toContain(': deskMenu ? everyTool.filter(tool => deskMenu.has(tool.name)) : everyTool,')
    expect(ipc).toContain('...(native && !lane && !company ? { native } : {}),')
  })
})
