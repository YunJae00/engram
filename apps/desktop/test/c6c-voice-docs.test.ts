import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { DESK_NOTE, deskKind, shareReady, tidyCounts, withOffer, withoutSameDecisions } from '../src/main/desk-lane.js'
import { laneFirstLine, SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'
import { ACK_MAX, beginFirstLine, cleanLine, endFirstLine, fallbackLine, firstLinePrompt, firstLineReady, laneLine, quickAnswerPrompt, saidBefore, splitAsk } from '../src/main/first-line.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const tail = (line: string) => line.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(-2).join(' ')

// grokbar cycle 6 (stack5-4e940bf4), rows D3-D5, T3, Q2, F1, H3.
describe('the first line does not repeat itself in a thread (D3, D4, D5)', () => {
  const DOCS = ['위 회의록으로 워드 보고서 만들어줘', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘']
  const run = async (message: string, reply: string, said: string[]) => {
    const show = vi.fn(), quick = vi.fn(async () => reply)
    beginFirstLine({ channel: 'bot-1', message, korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: 'C:/work' as never, signal: new AbortController().signal, show, said: async () => said, fallback: lines => fallbackLine(message, true, lines) })
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(10)
    endFirstLine('bot-1')
    return { line: show.mock.calls[0]?.[0] as string | undefined, prompt: (quick.mock.calls[0] as unknown[] | undefined)?.[0] as string | undefined, shown: show.mock.calls.length }
  }
  beforeEach(() => { vi.useFakeTimers(); endFirstLine('bot-1') })
  afterEach(() => { endFirstLine('bot-1'); vi.useRealTimers() })

  it('reads an ending as the last two words', () => {
    expect(saidBefore('3분기 실적 내용부터 정리할게요.', ['회의록 내용부터 정리할게요.'])).toBe(true)
    // c7c: a second "…부터" line is a repeat whatever its ending (D4: 매번 '~부터 할게요'); a line built another way is not.
    expect(saidBefore('매출 파일부터 살펴볼게요.', ['회의록 내용부터 정리할게요.', '3분기 실적 내용부터 정리할게요.'])).toBe(true)
    expect(saidBefore('매출 파일 바로 살펴볼게요.', ['회의록 내용부터 정리할게요.', '3분기 실적 내용부터 정리할게요.'])).toBe(false)
    expect(saidBefore('슬라이드 순서부터 잡을게요.', [])).toBe(false)
  })

  it('shows the voice the last two lines, and takes the host line when the voice repeats the ending', async () => {
    const first = await run(DOCS[0]!, '회의록 내용부터 정리할게요.', [])
    expect(first.line).toBe('회의록 내용부터 정리할게요.')
    expect(first.prompt).not.toContain('earlier in this conversation')
    const second = await run(DOCS[1]!, '3분기 실적 내용부터 정리할게요.', [first.line!])
    expect(second.prompt).toContain('Your first lines earlier in this conversation: "회의록 내용부터 정리할게요."')
    expect(second.prompt).toContain('Do not reuse their ending or their sentence frame')
    expect(second.shown).toBe(1)
    expect(second.line).not.toBe('3분기 실적 내용부터 정리할게요.')
    expect(saidBefore(second.line!, [first.line!])).toBe(false)
    // A line of its own is shown as the voice wrote it.
    expect((await run(DOCS[2]!, '월별로 먼저 더해 볼게요.', [first.line!, second.line!])).line).toBe('월별로 먼저 더해 볼게요.')
    // Only the last two are put in the prompt.
    expect(firstLinePrompt('x 정리해줘', true, ['하나 볼게요.', '둘 볼게요.', '셋 볼게요.'])).not.toContain('하나 볼게요.')
  })

  it('three document asks the voice has no line for give three different endings', async () => {
    const said: string[] = []
    for (const ask of DOCS) said.push((await run(ask, 'NONE', [...said])).line!)
    expect(new Set(said.map(tail)).size).toBe(3)
    // The same ask three times over turns its ending too, and each line is one short sentence that is not filler.
    const again: string[] = []
    for (let at = 0; at < 3; at++) again.push(fallbackLine('이 글 요약해줘', true, [...again]))
    expect(new Set(again.map(tail)).size).toBe(3)
    for (const line of [...said, ...again]) { expect([...line].length).toBeLessThanOrEqual(60); expect(line).toMatch(/^[^.!?]+게요\.$/); expect(line).not.toMatch(/알겠습니다|금방|곧/) }
    // With nothing said yet the line is the one it always was.
    expect(fallbackLine('이 글 요약해줘', true)).toBe('지금 정리할게요.')
    expect(fallbackLine('What is this?', false, ['Checking now.'])).toBe('Checking now.')
  })

  // c6c r3 (review r2): cleanLine let anything up to 140 characters through as the acknowledgement.
  it('never shows a voice line over 60 characters as the acknowledgement (rule 1)', async () => {
    const long = '회의록부터 확인하고 핵심 내용과 결정할 사항을 꼼꼼히 살펴본 다음 담당자별 할 일과 기한을 하나씩 짧게 정리할게요.'
    expect([...long].length).toBe(64)
    expect(ACK_MAX).toBe(60)
    expect(cleanLine(long, ACK_MAX)).toBeUndefined()
    const got = await run(DOCS[0]!, long, [])
    expect(got.shown).toBe(1)
    expect(got.line).toBe(fallbackLine(DOCS[0]!, true, []))
    expect([...got.line!].length).toBeLessThanOrEqual(ACK_MAX)
    // Exactly 60 is shown as written; a whole small-talk answer keeps its own, longer limit.
    const edge = '가'.repeat(55) + ' 볼게요.'
    expect([...edge].length).toBe(60)
    expect((await run(DOCS[0]!, edge, [])).line).toBe(edge)
    expect(cleanLine(long)).toBe(long)
    expect(firstLinePrompt('x 정리해줘', true)).toContain('at most 40 characters')
    // Every host-made first line is inside the limit too.
    for (const ask of [...DOCS, '엔비디아 오늘 주가 알려줘', 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', '클로드, GPT, 제미나이 비교해줘. 각각 따로 조사시켜']) for (const said of [[], [fallbackLine(ask, true, [])]]) expect([...fallbackLine(ask, true, said)].length, ask).toBeLessThanOrEqual(ACK_MAX)
  })

  it('keeps the budget and asks the voice once', () => {
    const file = source('first-line.ts')
    expect(file).toContain('export const FIRST_LINE_BUDGET_MS = 1500')
    expect(file.match(/engine\.quick\(/g)).toHaveLength(1)
    expect(source('ipc.ts')).toContain("said: async () => (request.botId ? await readBotTranscript(paths, request.botId, 12) : request.history ?? []).filter(one => one.role === 'assistant' && one.progress && !one.error")
  })

  it('a split ask is acknowledged as a split (T3)', async () => {
    const T3 = '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜'
    expect(firstLinePrompt(T3, true)).toContain('the line says the split in their words ("셋이 나눠서 알아볼게요.", "봇들한테 나눠 맡길게요.")')
    for (const ask of [T3, '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', '이번 주 경쟁사 3곳 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜']) {
      expect(splitAsk(ask), ask).toBe(true)
      expect(fallbackLine(ask, true), ask).toMatch(/나눠/)
      expect(laneLine(ask, true), ask).toMatch(/나눠/)
      // The voice's line that leaves the split out is replaced by one that says it; one that says it stays.
      expect((await run(ask, '각 모델 정보부터 조사할게요.', [])).line, ask).toMatch(/나눠/)
      expect((await run(ask, '셋이 나눠서 알아볼게요.', [])).line).toBe('셋이 나눠서 알아볼게요.')
    }
    expect(fallbackLine(T3, true)).toBe(laneFirstLine(T3, true))
    for (const ask of ['fixtures/inbox-dump 폴더 파일들 종류별로 나눠서 정리해줘', '회의록 요약해줘']) expect(splitAsk(ask), ask).toBe(false)
    // T3 ran after R2 with a route learned from it, which dropped the lookup's own line ("나눠서 알아볼게요.").
    expect(source('ipc.ts')).toContain('request.attachments?.length || (turn?.context && !turn.learned) ? {} : fastLane(request.message, true)')
  })
})

describe('a figure that rests on a convention says so (Q2)', () => {
  it('asks for the convention inside the one sentence, in both prompts', () => {
    for (const text of [quickAnswerPrompt('1년은 몇 초야?', true), SHORT_QUESTION_NOTE]) {
      expect(text).toContain('평년 기준으로 31,536,000초예요.')
      expect(text).toMatch(/a common (year )?or a leap year, a 30- or 31-day month, which exchange/)
    }
    expect(quickAnswerPrompt('1년은 몇 초야?', true)).toContain('still one sentence, never the other variant and never an "if" clause')
    expect(SHORT_QUESTION_NOTE).toContain('never adds the other variant')
  })
})

describe('a tidy job answers with counts, not a file list (F1)', () => {
  const F1_ASK = 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘'
  const F1 = ['inbox-dump 폴더를 종류별로 정리했어요.', '', '- PDF 폴더: 6개 — 견적서_A사.pdf, 계약서_초안.pdf, 세금계산서_10월.pdf, 제품소개서.pdf, 출장보고.pdf, 회의자료_1103.pdf', '- 이미지 폴더: 4개 — 로고_시안.png, 영수증_사진.png, 좌석배치도.png, 화면캡처_01.png', '- 문서 폴더: 3개 — 인사말.docx, 주간보고_44주차.docx, 채용공고_초안.docx', '- 엑셀 폴더: 3개 — 연락처목록.xlsx, 재고현황.xlsx, 출장비정산.xlsx', '- 텍스트 폴더: 4개 — wifi_안내.txt, 메모.txt, 전화메모_1112.txt, 할일.txt'].join('\n')

  it('pins the shape and the one move call', () => {
    expect(deskKind(F1_ASK)).toBe('tidy')
    // stack-6: BAR F1 asks for a summary list; the counts are one line per folder, still with no file names.
    expect(DESK_NOTE).toContain('one line per folder and nothing else on it ("- PDF 6개"), no table')
    expect(DESK_NOTE).toContain('move every file in ONE file_move call')
    expect(DESK_NOTE).toContain('File names are given only when they ask for them, or for the one or two files that fit no group.')
    expect(source('ipc.ts')).toContain("if (kind === 'tidy' && !result.asked) result.answer = tidyCounts(meant, result.answer)")
  })

  it('turns the stored F1 answer into a short list of counts, with every count kept for F2', () => {
    const answer = tidyCounts(F1_ASK, F1)
    expect(answer).toBe('inbox-dump 폴더를 종류별로 정리했어요.\n\n- PDF 6개\n- 이미지 4개\n- 문서 3개\n- 엑셀 3개\n- 텍스트 4개')
    // stack-6 (c6c run, F1): the one sentence the run showed failed BAR's "summary list"; it becomes the same list.
    expect(tidyCounts(F1_ASK, 'inbox-dump 폴더를 파일 종류별로 정리했어요. PDF 6개, 이미지 4개, 문서 3개, 엑셀 3개, 텍스트 4개예요.')).toBe(answer.replace('종류별로', '파일 종류별로'))
    expect(answer.split('\n').filter(line => /^- /.test(line))).toHaveLength(5)
    expect(answer).not.toMatch(/\.(pdf|png|docx|xlsx|txt)/)
    // The thread's plain-text form (no list marks) and a list with counts only come out the same.
    expect(tidyCounts(F1_ASK, F1.replace(/^- /gm, ''))).toBe(answer)
    expect(tidyCounts(F1_ASK, '종류별 폴더로 정리했어요.\n- PDF 폴더: 6개\n- 이미지 폴더: 4개')).toBe('종류별 폴더로 정리했어요.\n\n- PDF 6개\n- 이미지 4개')
  })

  it('leaves names they asked for, the odd file out, and an answer already in shape', () => {
    expect(tidyCounts('fixtures/inbox-dump 폴더 정리하고 파일 이름도 알려줘', F1)).toBe(F1)
    const odd = '종류별 폴더로 정리했어요. PDF 6개, 이미지 4개예요.\n기타: 2개 — 메모.hwp, 백업.zip'
    expect(tidyCounts(F1_ASK, odd)).toBe(odd)
    const done = '종류별 폴더로 정리했어요.\n\n- PDF 6개\n- 이미지 4개\n- 문서 3개'
    expect(tidyCounts(F1_ASK, done)).toBe(done)
  })
})

describe('a share-ready summary says what it chose and stays short (H3)', () => {
  const H3_ASK = 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', D1_ASK = 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘'
  // The stored answer (runs/stack5-4e940bf4/H3.txt), as the thread shows it.
  const H3 = ['회의록을 팀 공유용으로 정리할게요.', '', '제품팀 주간 회의 공유', '', '일시: 2026년 11월 16일(월) 오전 10시 / 장소: 3층 회의실 B', '참석: 한서연, 오태민, 윤가은, 백도현, 나', '', '논의 내용', '온보딩 이탈률 38%(지난달)로 높아, 한서연이 3단계로 줄인 시안 두 가지 중 B안 선호 의견 다수', '결제 모듈이 내년 1월 지원 종료되어, 오태민이 후보 두 곳 비교 (교체 작업 약 3주 소요 예상)', '베타 테스터가 12명뿐이라 윤가은이 커뮤니티 공지로 추가 모집 제안', '4분기 마케팅 예산은 아직 초안 단계, 백도현이 광고비·행사비 구분해 재정리 예정',
    '결정사항', '신규 온보딩 화면 시안 확정', '결제 모듈 교체 일정 수립', '베타 테스터 50명 모집 공지 발송', '4분기 마케팅 예산안 제출',
    '할 일', '한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '미결', '결제 모듈 후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  const marked = H3.replace(/^(논의 내용|결정사항|할 일|미결)$/gm, '**$1**').replace(/^(?!\*\*|일시|참석|회의록을|제품팀|다음 회의|$)(.+)$/gm, '- $1')

  it('drops a 결정사항 block that the 할 일 lines say again, heading and all', () => {
    for (const answer of [H3, marked]) {
      const out = withoutSameDecisions(H3_ASK, answer)
      expect(out).not.toContain('결정사항')
      expect(out.match(/온보딩 화면 시안 확정/g)).toHaveLength(1)
      // Every task with its owner and date, the open item and the next meeting are still there (the row's check wants two decision keywords).
      for (const kept of ['한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '할 일', '미결', '결제 모듈 후보 두 곳 중 선택은', '다음 회의: 11월 23일(월) 오전 10시', '논의 내용']) expect(out, kept).toContain(kept)
      expect(out.split('\n').length).toBe(answer.split('\n').length - 5)
    }
    expect(marked).toContain('- 신규 온보딩 화면 시안 확정')
  })

  it('leaves an ask that names the decisions alone (D1), and two blocks that differ', () => {
    expect(withoutSameDecisions(D1_ASK, H3)).toBe(H3)
    expect(withoutSameDecisions('회의록에서 결정사항만 뽑아줘', H3)).toBe(H3)
    // The stored D1 answer: 결정사항 says what was agreed, 할 일 who does it.
    const D1 = ['결정사항', '', '신규 온보딩 화면은 한서연이 제안한 B안으로 시안을 확정하기로 했어요.', '결제 모듈 교체 일정을 세우기로 했어요(후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정).', '베타 테스터 50명 모집 공지를 내보내기로 했어요.', '4분기 마케팅 예산안을 광고비·행사비로 나눠 다시 제출하기로 했어요.', '', '할 일', '', '한서연 — 온보딩 화면 시안 확정, 11월 20일까지', '오태민 — 결제 모듈 교체 일정 수립, 11월 24일까지', '윤가은 — 베타 테스터 50명 모집 공지 발송, 11월 27일까지', '백도현 — 4분기 마케팅 예산안 제출, 12월 1일까지'].join('\n')
    expect(withoutSameDecisions(H3_ASK, D1)).toBe(D1)
    // One decision with no task of its own keeps the block.
    const mixed = H3.replace('4분기 마케팅 예산안 제출\n할 일', '사무실 이전은 내년으로 미룸\n할 일')
    expect(withoutSameDecisions(H3_ASK, mixed)).toBe(mixed)
    const none = '할 일\n- 한서연 — 시안 확정 (11/20)'
    expect(withoutSameDecisions(H3_ASK, none)).toBe(none)
  })

  // c6c r2: the round 1 review replayed the stored answer and still found 20 lines, the promise lead, 일시, 참석 and 논의 내용.
  it('turns the stored answer into a short one that opens on what was chosen', () => {
    for (const answer of [H3, marked]) {
      const out = shareReady(H3_ASK, withoutSameDecisions(H3_ASK, answer))
      expect(out.split('\n')[0]).toBe('할 일이랑 미결 위주로 짧게 정리했어요.')
      for (const gone of ['정리할게요', '일시', '참석', '3층 회의실', '논의 내용', '이탈률', '제품팀 주간 회의 공유', '결정사항']) expect(out, gone).not.toContain(gone)
      for (const kept of ['한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '결제 모듈 후보 두 곳 중 선택은', '다음 회의: 11월 23일(월) 오전 10시']) expect(out, kept).toContain(kept)
      expect(out.split('\n').filter(line => line.trim()).length).toBeLessThanOrEqual(9)
      expect(out).not.toMatch(/\?/)
    }
    expect(shareReady(H3_ASK, withoutSameDecisions(H3_ASK, H3))).toBe(['할 일이랑 미결 위주로 짧게 정리했어요.', '', '할 일', '한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '미결', '결제 모듈 후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n'))
    // A summary that opens on its heading gets the lead; one that already says its choice keeps it; suggested replies stay last.
    expect(shareReady('회의록 보기 좋게 정리해줘', '## 할 일\n- 한서연: 시안 확정 (11/20)\n\n```replies\n표로\n```')).toBe('할 일 위주로 짧게 정리했어요.\n\n## 할 일\n- 한서연: 시안 확정 (11/20)\n\n```replies\n표로\n```')
    const said = '담당자별 할 일만 추렸어요.\n\n할 일\n- 한서연: 시안 확정 (11/20)'
    expect(shareReady(H3_ASK, said)).toBe(said)
  })

  it('leaves the shape alone when the ask is not open-form or names a part (D1, H4)', () => {
    const D1 = `11월 16일 제품팀 주간 회의록을 결정사항과 할 일로 정리할게요.\n\n${H3.split('\n').slice(4).join('\n')}`
    for (const ask of [D1_ASK, 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘', '회의록 요약해줘', '참석자랑 논의 내용까지 공유하기 좋게 정리해줘', '결정사항 위주로 보기 좋게 정리해줘']) expect(shareReady(ask, D1), ask).toBe(D1)
    // Nothing to stand on: no 할 일 block, so nothing is cut.
    const prose = '회의록을 정리할게요.\n\n일시: 11월 16일\n온보딩 시안은 B안으로 가기로 했어요.'
    expect(shareReady(H3_ASK, prose)).toBe(prose)
  })

  it('pins the open-form note and the order of the host fixes; H4 still gets its one offer', () => {
    expect(deskKind(H3_ASK)).toBe('note')
    expect(DESK_NOTE).toContain('the first sentence says what you chose, in the past tense, and is the only lead ("할 일이랑 미결 위주로 짧게 정리했어요."), never a promise ("…정리할게요.")')
    expect(DESK_NOTE).toContain('at most about eight short lines: who does what by when, then what is still open, then the next meeting')
    expect(DESK_NOTE).toContain('something not settled yet goes under 미결, never under 결정사항')
    const ipc = source('ipc.ts')
    expect(ipc.indexOf("result.answer = withoutSameDecisions(meant, result.answer)")).toBeGreaterThan(0)
    expect(ipc.indexOf("result.answer = withoutSameDecisions(meant, result.answer)")).toBeLessThan(ipc.indexOf('result.answer = withOffer(meant, result.answer, savedHistory'))
    expect(ipc.indexOf('result.answer = withoutSameDecisions(meant, result.answer)')).toBeLessThan(ipc.indexOf('result.answer = shareReady(meant, result.answer)'))
    expect(ipc.indexOf('result.answer = shareReady(meant, result.answer)')).toBeLessThan(ipc.indexOf('result.answer = withOffer(meant, result.answer, savedHistory'))
    const todo = '- 한서연: 온보딩 화면 시안 확정 (11/20)\n- 오태민: 결제 모듈 교체 일정 수립 (11/24)'
    const H4 = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
    expect(withOffer(H4, withoutSameDecisions(H4, todo), [], true)).toBe(`${todo}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`)
  })
})

// stack-6: c6c-review.r3 finding 1, the reviewer's own input.
it('stack-6: a split asked as a question still gets a line that says the split; a plain question keeps its own', async () => {
  const { laneLine } = await import('../src/main/first-line.js')
  expect(laneLine('지민이랑 서연한테 나눠서 조사해줄래?', true)).toBe('누가 뭘 맡을지 나눠 볼게요.')
  expect(laneLine('다들 뭐 하고 있어?', true)).toBe('지금 확인해 볼게요.')
})

// stack-6 (c6c run, H4): the row passed in stack-5 and came back with a 미결 block under "할 일만".
it('stack-6: "할 일만" gets the tasks only: the 미결 block and the lone heading go, every task stays, other asks are left alone', async () => {
  const { onlyAsked } = await import('../src/main/desk-lane.js')
  const tasks = ['한서연: 신규 온보딩 화면 시안 확정 — 11월 20일까지', '오태민: 결제 모듈 교체 일정 수립 — 11월 24일까지', '윤가은: 베타 테스터 50명 모집 공지 발송 — 11월 27일까지', '백도현: 4분기 마케팅 예산안 제출 — 12월 1일까지']
  const shown = ['회의록에서 할 일을 뽑아봤어요.', '', '할 일', '', ...tasks, '', '미결', '', '결제 모듈 후보 두 곳 중 어디로 갈지는 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  expect(onlyAsked(ask, shown)).toBe(['회의록에서 할 일을 뽑아봤어요.', '', ...tasks].join('\n'))
  // The bold-heading, list-marked form, with suggested replies kept last.
  const marked = ['**할 일**', ...tasks.map(line => `- ${line}`), '', '**미결**', '- 결제 모듈 후보 선택', '', '```replies', '담당자별로 나눠줘', '```'].join('\n')
  expect(onlyAsked(ask, marked)).toBe([...tasks.map(line => `- ${line}`), '', '```replies', '담당자별로 나눠줘', '```'].join('\n'))
  // No 미결 block, or an ask that does not say "only": untouched (H3, D1).
  expect(onlyAsked(ask, tasks.join('\n'))).toBe(tasks.join('\n'))
  expect(onlyAsked('fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', shown)).toBe(shown)
  expect(source('ipc.ts')).toContain("if (kind === 'note' && !result.asked) result.answer = onlyAsked(meant, result.answer)")
})

// stack-6: where c6c's host corrections may act, pinned on the merged tree (stack6-brief section 1).
it('stack-6: the repeat check is the quick voice\'s only, and the block corrections are a desk note\'s only', () => {
  const first = source('first-line.ts'), ipc = source('ipc.ts')
  // The team lane's host-made line ("지민한테 맡겼어요.", firstLineNow) and the reply to a mid-work message (aside-ipc asideReply) never pass it.
  expect(first.slice(first.indexOf('export function firstLineNow'))).not.toContain('saidBefore')
  expect(source('aside-ipc.ts')).not.toMatch(/saidBefore|splitLine|fallbackLine/)
  // Never on a team result, a lookup or a document: each call hangs on the desk kind, which those turns do not have.
  for (const fix of ['withoutSameDecisions', 'shareReady', 'onlyAsked']) expect(ipc.split('\n').filter(line => line.includes(`${fix}(`) && !line.includes('import'))).toEqual([expect.stringContaining(`if (kind === 'note' && !result.asked) result.answer = ${fix}(meant, result.answer)`)])
  expect(ipc.split('\n').filter(line => line.includes('tidyCounts(') && !line.includes('import'))).toEqual([expect.stringContaining("if (kind === 'tidy' && !result.asked)")])
})
