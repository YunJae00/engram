import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).split('result.answer = ').length - 1
import { DESK_NOTE, deskKind } from '../src/main/desk-lane.js'
import { laneFirstLine, SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'
import { ACK_MAX, beginFirstLine, cleanLine, endFirstLine, fallbackLine, firstLinePrompt, firstLineReady, laneLine, quickAnswerPrompt, saidBefore, splitAsk } from '../src/main/first-line.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
async function deskTurn(draft: string, said: string) {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c6c-voice' as EngineCwd, tools: [] }, said, { attachmentContext: DESK_NOTE })
  return { posted: result.answer, calls: jobs.length, told: jobs.map(job => `${job.system}\n${job.prompt}`).join('\n') }
}
const tail = (line: string) => line.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(-2).join(' ')

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
    expect(saidBefore('매출 파일부터 살펴볼게요.', ['회의록 내용부터 정리할게요.', '3분기 실적 내용부터 정리할게요.'])).toBe(true)
    expect(saidBefore('매출 파일 바로 살펴볼게요.', ['회의록 내용부터 정리할게요.', '3분기 실적 내용부터 정리할게요.'])).toBe(false)
    expect(saidBefore('슬라이드 순서부터 잡을게요.', [])).toBe(false)
  })

  it('shows the voice the last two lines, and posts its line as written even when it repeats the ending', async () => {
    const first = await run(DOCS[0]!, '회의록 내용부터 정리할게요.', [])
    expect(first.line).toBe('회의록 내용부터 정리할게요.')
    expect(first.prompt).not.toContain('earlier in this conversation')
    const second = await run(DOCS[1]!, '3분기 실적 내용부터 정리할게요.', [first.line!])
    expect(second.prompt).toContain('Your first lines earlier in this conversation: "회의록 내용부터 정리할게요."')
    expect(second.prompt).toContain('Do not reuse their ending or their sentence frame')
    expect(second.shown).toBe(1)
    expect(second.line).toBe('3분기 실적 내용부터 정리할게요.')
    expect((await run(DOCS[2]!, '월별로 먼저 더해 볼게요.', [first.line!, second.line!])).line).toBe('월별로 먼저 더해 볼게요.')
    expect(firstLinePrompt('x 정리해줘', true, ['하나 볼게요.', '둘 볼게요.', '셋 볼게요.'])).not.toContain('하나 볼게요.')
  })

  it('three document asks the voice has no line for give three different endings', async () => {
    const said: string[] = []
    for (const ask of DOCS) said.push((await run(ask, '', [...said])).line!)
    expect(new Set(said.map(tail)).size).toBe(3)
    const again: string[] = []
    for (let at = 0; at < 3; at++) again.push(fallbackLine('이 글 요약해줘', true, [...again]))
    expect(new Set(again.map(tail)).size).toBe(3)
    for (const line of [...said, ...again]) { expect([...line].length).toBeLessThanOrEqual(60); expect(line).toMatch(/^[^.!?]+게요\.$/); expect(line).not.toMatch(/알겠습니다|금방|곧/) }
    expect(fallbackLine('이 글 요약해줘', true)).toBe('지금 정리할게요.')
    expect(fallbackLine('What is this?', false, ['Checking now.'])).toBe('Checking now.')
  })

  it('never shows a voice line over 60 characters as the acknowledgement (rule 1)', async () => {
    const long = '회의록부터 확인하고 핵심 내용과 결정할 사항을 꼼꼼히 살펴본 다음 담당자별 할 일과 기한을 하나씩 짧게 정리할게요.'
    expect([...long].length).toBe(64)
    expect(ACK_MAX).toBe(60)
    expect(cleanLine(long, ACK_MAX)).toBeUndefined()
    const got = await run(DOCS[0]!, long, [])
    expect(got.shown).toBe(1)
    expect(got.line).toBe(fallbackLine(DOCS[0]!, true, []))
    expect([...got.line!].length).toBeLessThanOrEqual(ACK_MAX)
    const edge = '가'.repeat(55) + ' 볼게요.'
    expect([...edge].length).toBe(60)
    expect((await run(DOCS[0]!, edge, [])).line).toBe(edge)
    expect(cleanLine(long)).toBe(long)
    expect(firstLinePrompt('x 정리해줘', true)).toContain('at most 40 characters')
    for (const ask of [...DOCS, '엔비디아 오늘 주가 알려줘', 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', '클로드, GPT, 제미나이 비교해줘. 각각 따로 조사시켜']) for (const said of [[], [fallbackLine(ask, true, [])]]) expect([...fallbackLine(ask, true, said)].length, ask).toBeLessThanOrEqual(ACK_MAX)
  })

  it('keeps the budget and asks the voice once on a turn that only needs a first line', async () => {
    const file = source('first-line.ts')
    expect(file).toContain('export const FIRST_LINE_BUDGET_MS = 1500')
    const quick = vi.fn(async () => '목차부터 세워 볼게요.')
    beginFirstLine({ channel: 'bot-1', message: '여름 워크숍 안내문 써줘', korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: 'C:/work' as never, signal: new AbortController().signal, show: vi.fn() })
    await vi.advanceTimersByTimeAsync(10)
    expect(quick).toHaveBeenCalledOnce()
    expect(source('ipc.ts')).toContain("said: async () => (await readBotTranscript(paths, bot.id, 12)).filter(one => one.role === 'assistant' && one.progress && !one.error")
  })

  it('a split ask is told to the voice as a split, and the voice line is posted as written (T3)', async () => {
    const T3 = '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜'
    expect(firstLinePrompt(T3, true)).toContain('the line says the split in their words ("셋이 나눠서 알아볼게요.", "봇들한테 나눠 맡길게요.")')
    for (const ask of [T3, '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', '이번 주 경쟁사 3곳 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜']) {
      expect(splitAsk(ask), ask).toBe(true)
      expect(fallbackLine(ask, true), ask).toMatch(/나눠/)
      expect(laneLine(ask, true), ask).toMatch(/나눠/)
      expect((await run(ask, '가격표부터 훑어볼게요.', [])).line, ask).toBe('가격표부터 훑어볼게요.')
      expect((await run(ask, '셋이 나눠서 알아볼게요.', [])).line).toBe('셋이 나눠서 알아볼게요.')
    }
    expect(fallbackLine(T3, true)).toBe(laneFirstLine(T3, true))
    for (const ask of ['fixtures/inbox-dump 폴더 파일들 종류별로 나눠서 정리해줘', '회의록 요약해줘']) expect(splitAsk(ask), ask).toBe(false)
    expect(source('ipc.ts')).toContain('bare: !!(request.attachments?.length || (turn?.context && !turn.learned))')
    expect(source('answer.ts')).toContain('...(bare ? {} : { told: onlyTells(message, lastReplyOf(earlier ?? world.history)), whole: quickQuestion(message) })')
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

  it('pins the shape and the one move call in what the model is told; the chat turn reshapes nothing', async () => {
    expect(deskKind(F1_ASK)).toBe('tidy')
    expect(DESK_NOTE).toContain('then how many files went into each folder, no list and no table')
    expect(DESK_NOTE).toContain('move every file in ONE file_move call')
    expect(DESK_NOTE).toContain('File names are given only when they ask for them, or for the one or two files that fit no group.')
    expect((await deskTurn(F1, F1_ASK)).told).toContain('Files you sorted are told as counts per kind in one sentence, without file names unless asked.')
    expect(answerSetInTurn(source('ipc.ts'))).toBe(1)
  })

  it('posts the stored F1 answer as the model wrote it, file names and all, and a short list of counts the same way', async () => {
    const { posted, calls } = await deskTurn(F1, F1_ASK)
    expect(posted).toBe(F1)
    expect(posted).toMatch(/\.(pdf|png|docx|xlsx|txt)/)
    expect(calls).toBe(1)
    const counts = '받은 파일을 갈래마다 나눠 담았어요.\n\n- PDF 6개\n- 이미지 4개\n- 문서 3개\n- 엑셀 3개\n- 텍스트 4개'
    const short = await deskTurn(counts, F1_ASK)
    expect(short.posted).toBe(counts)
    expect(short.posted.split('\n').filter(line => /^- /.test(line))).toHaveLength(5)
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })

  it('leaves names they asked for, the odd file out, and an answer already in shape', async () => {
    expect((await deskTurn(F1, '옮긴 파일 이름까지 같이 적어줘')).posted).toBe(F1)
    const odd = '종류별 폴더로 정리했어요. PDF 6개, 이미지 4개예요.\n기타: 2개 — 메모.hwp, 백업.zip'
    expect((await deskTurn(odd, F1_ASK)).posted).toBe(odd)
    const done = '종류별 폴더로 정리했어요.\n\n- PDF 6개\n- 이미지 4개\n- 문서 3개'
    expect((await deskTurn(done, F1_ASK)).posted).toBe(done)
  })
})

describe('a share-ready summary says what it chose and stays short (H3)', () => {
  const H3_ASK = 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘', D1_ASK = 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘'
  const H3 = ['회의록을 팀 공유용으로 정리할게요.', '', '제품팀 주간 회의 공유', '', '일시: 2026년 11월 16일(월) 오전 10시 / 장소: 3층 회의실 B', '참석: 한서연, 오태민, 윤가은, 백도현, 나', '', '논의 내용', '온보딩 이탈률 38%(지난달)로 높아, 한서연이 3단계로 줄인 시안 두 가지 중 B안 선호 의견 다수', '결제 모듈이 내년 1월 지원 종료되어, 오태민이 후보 두 곳 비교 (교체 작업 약 3주 소요 예상)', '베타 테스터가 12명뿐이라 윤가은이 커뮤니티 공지로 추가 모집 제안', '4분기 마케팅 예산은 아직 초안 단계, 백도현이 광고비·행사비 구분해 재정리 예정',
    '결정사항', '신규 온보딩 화면 시안 확정', '결제 모듈 교체 일정 수립', '베타 테스터 50명 모집 공지 발송', '4분기 마케팅 예산안 제출',
    '할 일', '한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '미결', '결제 모듈 후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  const marked = H3.replace(/^(논의 내용|결정사항|할 일|미결)$/gm, '**$1**').replace(/^(?!\*\*|일시|참석|회의록을|제품팀|다음 회의|$)(.+)$/gm, '- $1')

  const SHORT = ['할 일이랑 미결 위주로 짧게 정리했어요.', '', '할 일', '한서연 — 온보딩 화면 시안 확정 (11/20)', '오태민 — 결제 모듈 교체 일정 수립 (11/24)', '윤가은 — 베타 테스터 50명 모집 공지 발송 (11/27)', '백도현 — 4분기 마케팅 예산안 제출 (12/1)', '미결', '결제 모듈 후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')

  it('a 결정사항 block that the 할 일 lines say again is the model\'s to leave out: it is told so, and its answer keeps every line it wrote', async () => {
    for (const answer of [H3, marked]) {
      const { posted, told } = await deskTurn(answer, H3_ASK)
      expect(told).toContain('No 일시, 참석 or 논의 blocks and no 결정사항 block beside the 할 일 unless they ask')
      expect(told).toContain('A decision or item is listed once, never again under a second heading.')
      expect(posted).toBe(answer)
      expect(posted.match(/온보딩 화면 시안 확정/g)).toHaveLength(2)
      expect(posted.split('\n').length).toBe(answer.split('\n').length)
    }
    expect(marked).toContain('- 신규 온보딩 화면 시안 확정')
  })

  it('leaves an ask that names the decisions alone (D1), and two blocks that differ', async () => {
    expect((await deskTurn(H3, D1_ASK)).posted).toBe(H3)
    expect((await deskTurn(H3, '회의록에서 결정사항만 뽑아줘')).posted).toBe(H3)
    const D1 = ['결정사항', '', '신규 온보딩 화면은 한서연이 제안한 B안으로 시안을 확정하기로 했어요.', '결제 모듈 교체 일정을 세우기로 했어요(후보 두 곳 중 선택은 견적 받은 뒤 다음 회의에서 결정).', '베타 테스터 50명 모집 공지를 내보내기로 했어요.', '4분기 마케팅 예산안을 광고비·행사비로 나눠 다시 제출하기로 했어요.', '', '할 일', '', '한서연 — 온보딩 화면 시안 확정, 11월 20일까지', '오태민 — 결제 모듈 교체 일정 수립, 11월 24일까지', '윤가은 — 베타 테스터 50명 모집 공지 발송, 11월 27일까지', '백도현 — 4분기 마케팅 예산안 제출, 12월 1일까지'].join('\n')
    expect((await deskTurn(D1, H3_ASK)).posted).toBe(D1)
    const mixed = H3.replace('4분기 마케팅 예산안 제출\n할 일', '사무실 이전은 내년으로 미룸\n할 일')
    expect((await deskTurn(mixed, H3_ASK)).posted).toBe(mixed)
    const none = '할 일\n- 한서연 — 시안 확정 (11/20)'
    expect((await deskTurn(none, H3_ASK)).posted).toBe(none)
  })

  it('the short answer that opens on what was chosen is asked of the model and posted as written; a long one is not cut down by the host', async () => {
    const { posted, told } = await deskTurn(SHORT, H3_ASK)
    expect(told).toContain('the first sentence says what you chose, in the past tense, and is the only lead ("할 일이랑 미결 위주로 짧게 정리했어요."), never a promise ("…정리할게요.")')
    expect(posted).toBe(SHORT)
    expect(posted.split('\n').filter(line => line.trim()).length).toBeLessThanOrEqual(9)
    for (const answer of [H3, marked]) {
      const long = (await deskTurn(answer, H3_ASK)).posted
      expect(long.split('\n')[0]).toBe('회의록을 팀 공유용으로 정리할게요.')
      for (const kept of ['일시', '참석', '3층 회의실', '논의 내용', '이탈률', '제품팀 주간 회의 공유', '결정사항']) expect(long, kept).toContain(kept)
    }
    const blocked = '## 할 일\n- 한서연: 시안 확정 (11/20)\n\n```replies\n표로\n```'
    expect((await deskTurn(blocked, '산악회 메모 한눈에 들어오게 다듬어줘')).posted).toBe(blocked)
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })

  it('leaves the shape alone when the ask is not open-form or names a part (D1, H4)', async () => {
    const D1 = `11월 16일 제품팀 주간 회의록을 결정사항과 할 일로 정리할게요.\n\n${H3.split('\n').slice(4).join('\n')}`
    for (const ask of [D1_ASK, '산악회 메모에서 준비물만 골라줘', '메모 간추려줘', '온 사람이랑 나눈 얘기까지 넣어서 다듬어줘', '정해진 것 중심으로 다듬어줘']) expect((await deskTurn(D1, ask)).posted, ask).toBe(D1)
    const prose = '회의록을 정리할게요.\n\n일시: 11월 16일\n온보딩 시안은 B안으로 가기로 했어요.'
    expect((await deskTurn(prose, H3_ASK)).posted).toBe(prose)
  })

  it('pins the open-form note; the chat turn has no host fix between the model\'s answer and its delivery, and H4\'s offer is the model\'s own line', async () => {
    expect(deskKind(H3_ASK)).toBe('note')
    expect(DESK_NOTE).toContain('the first sentence says what you chose, in the past tense, and is the only lead ("할 일이랑 미결 위주로 짧게 정리했어요."), never a promise ("…정리할게요.")')
    expect(DESK_NOTE).toContain('at most about eight short lines: who does what by when, then what is still open, then the next meeting')
    expect(DESK_NOTE).toContain('something not settled yet goes under 미결, never under 결정사항')
    const ipc = source('ipc.ts')
    expect(answerSetInTurn(ipc)).toBe(1)
    expect(ipc.split('\n').filter(line => /result\.answer = /.test(line)).map(line => line.trim())).toEqual([expect.stringContaining('result.answer = answered }')])
    const todo = '- 한서연: 온보딩 화면 시안 확정 (11/20)\n- 오태민: 결제 모듈 교체 일정 수립 (11/24)'
    const H4 = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
    expect((await deskTurn(todo, H4)).posted).toBe(todo)
    expect((await deskTurn(`${todo}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`, H4)).posted).toBe(`${todo}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`)
  })
})

it('stack-6: a split asked as a question still gets a line that says the split; a plain question keeps its own', async () => {
  const { laneLine } = await import('../src/main/first-line.js')
  expect(laneLine('지민이랑 서연한테 나눠서 조사해줄래?', true)).toBe('누가 뭘 맡을지 나눠 볼게요.')
  expect(laneLine('다들 뭐 하고 있어?', true)).toBe('지금 확인해 볼게요.')
})

it('stack-6: "할 일만" is asked of the model as that part only; a reply with a 미결 block and a lone heading is posted as written, every task kept', async () => {
  const tasks = ['한서연: 신규 온보딩 화면 시안 확정 — 11월 20일까지', '오태민: 결제 모듈 교체 일정 수립 — 11월 24일까지', '윤가은: 베타 테스터 50명 모집 공지 발송 — 11월 27일까지', '백도현: 4분기 마케팅 예산안 제출 — 12월 1일까지']
  const shown = ['회의록에서 할 일을 뽑아봤어요.', '', '할 일', '', ...tasks, '', '미결', '', '결제 모듈 후보 두 곳 중 어디로 갈지는 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  const { posted, told } = await deskTurn(shown, ask)
  expect(told).toContain('gives that part only, its lines with no heading over them: no 미결, no next meeting, nothing they did not ask for.')
  expect(told).toContain('When they ask for one part of something, give that part only.')
  expect(posted).toBe(shown)
  const marked = ['**할 일**', ...tasks.map(line => `- ${line}`), '', '**미결**', '- 결제 모듈 후보 선택', '', '```replies', '담당자별로 나눠줘', '```'].join('\n')
  expect((await deskTurn(marked, ask)).posted).toBe(marked)
  expect((await deskTurn(tasks.join('\n'), ask)).posted).toBe(tasks.join('\n'))
  expect((await deskTurn(shown, '산악회 메모 돌려 보기 편하게 다듬어줘')).posted).toBe(shown)
  expect(answerSetInTurn(source('ipc.ts'))).toBe(1)
})

it('stack-6: the repeat check is the quick voice\'s only, and no block correction is left in the chat turn or the desk lane', () => {
  const first = source('first-line.ts'), ipc = source('ipc.ts')
  expect(first.slice(first.indexOf('export function firstLineNow'))).not.toContain('saidBefore')
  expect(source('aside-ipc.ts')).not.toMatch(/saidBefore|splitLine|fallbackLine/)
  expect(answerSetInTurn(ipc)).toBe(1)
  expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain("const deskNote = desk && !short ? [DESK_NOTE, given ? fileGiven(given) : ''].filter(Boolean).join('\\n\\n') : ''")
})
