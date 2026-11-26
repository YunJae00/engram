import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['fixSlideTitle', 'keepAsk', 'keptFix', 'kindSortAsk', 'plainKeep', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).split('result.answer = ').length - 1
import { COLLEAGUE_RULE as VOICE } from '../../../packages/core/src/agent-voice.js'
import { ACK_MAX, beginFirstLine, cleanLine, endFirstLine, firstLinePrompt, firstLineReady } from '../src/main/first-line.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const COLLEAGUE_RULE = readFileSync(new URL('../../../packages/core/src/agent-voice.ts', import.meta.url), 'utf8')
async function deskTurn(draft: string, said: string) {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c6c-voice' as EngineCwd, tools: [] }, said)
  return { posted: result.answer, calls: jobs.length, told: jobs.map(job => `${job.system}\n${job.prompt}`).join('\n') }
}

describe('the first line does not repeat itself in a thread (D3, D4, D5)', () => {
  const DOCS = ['위 회의록으로 워드 보고서 만들어줘', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘']
  const run = async (message: string, reply: string, said: string[]) => {
    const show = vi.fn(), quick = vi.fn(async () => reply)
    beginFirstLine({ channel: 'bot-1', message, korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => ({ id: 'claude' as const, quick }) as never, workdir: 'C:/work' as never, signal: new AbortController().signal, show, said: async () => said })
    firstLineReady('bot-1')
    await vi.advanceTimersByTimeAsync(10)
    endFirstLine('bot-1')
    return { line: show.mock.calls[0]?.[0] as string | undefined, prompt: (quick.mock.calls[0] as unknown[] | undefined)?.[0] as string | undefined, shown: show.mock.calls.length }
  }
  beforeEach(() => { vi.useFakeTimers(); endFirstLine('bot-1') })
  afterEach(() => { endFirstLine('bot-1'); vi.useRealTimers() })

  it('reads no ending in the host: the voice is told the earlier lines, and a line on the same ending is posted unchanged', async () => {
    const earlier = ['메모 내용부터 훑어볼게요.', '일정표부터 훑어볼게요.']
    const got = await run('다음 주 워크숍 진행표 만들어줘', '시간 순서부터 훑어볼게요.', earlier)
    expect(got.prompt).toContain('"메모 내용부터 훑어볼게요.", "일정표부터 훑어볼게요."')
    expect(got.line).toBe('시간 순서부터 훑어볼게요.')
    expect(got.shown).toBe(1)
    expect(firstLinePrompt('다음 주 워크숍 진행표 만들어줘', true, earlier)).toBe(firstLinePrompt('다음 주 워크숍 진행표 만들어줘', true, ['메모 내용 볼게요.', '일정표 열게요.']).replace('"메모 내용 볼게요.", "일정표 열게요."', '"메모 내용부터 훑어볼게요.", "일정표부터 훑어볼게요."'))
  })

  it('three document asks the voice has no line for show nothing of their own, and only the one safety line stands in at 1.3 s', async () => {
    const asks = ['출장 경비 내역 엑셀로 묶어줘', '신입 교육 자료 슬라이드 4장 만들어줘', '고객 문의 메모로 워드 정리본 만들어줘']
    for (const ask of asks) expect((await run(ask, '', [])).shown, ask).toBe(0)
    const shown: string[] = []
    for (const ask of asks) {
      endFirstLine('bot-1')
      beginFirstLine({ channel: 'bot-1', message: ask, korean: true, interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => ({ id: 'claude' as const, quick: async () => 'NONE' }) as never, workdir: 'C:/work' as never, signal: new AbortController().signal, show: line => shown.push(line), said: async () => shown })
      firstLineReady('bot-1')
      await vi.advanceTimersByTimeAsync(1300)
    }
    expect(shown).toEqual(Array(3).fill('바로 확인해 볼게요.'))
  })

  it('a split asked as a question is the voice\'s to name: its prompt carries the split rule and its line is posted as written', async () => {
    const ask = '하은이랑 수진한테 나눠서 숙소 알아봐 줄래?'
    expect(firstLinePrompt(ask, true)).toContain('the line says the split in their words')
    expect((await run(ask, '하은이랑 수진한테 나눠 맡길게요.', [])).line).toBe('하은이랑 수진한테 나눠 맡길게요.')
    expect((await run('둘이 뭐 하고 있어?', '지금 확인해 볼게요.', [])).line).toBe('지금 확인해 볼게요.')
  })

  it('shows the voice the last two lines, and posts its line as written even when it repeats the ending', async () => {
    const first = await run(DOCS[0]!, '회의록 내용부터 정리할게요.', [])
    expect(first.line).toBe('회의록 내용부터 정리할게요.')
    expect(first.prompt).not.toContain('earlier in this conversation')
    const second = await run(DOCS[1]!, '3분기 실적 내용부터 정리할게요.', [first.line!])
    expect(second.prompt).toContain('Your first lines earlier in this conversation: "회의록 내용부터 정리할게요."')
    expect(second.prompt).toContain('Do not reuse their ending, their last word or their sentence frame')
    expect(second.shown).toBe(1)
    expect(second.line).toBe('3분기 실적 내용부터 정리할게요.')
    expect((await run(DOCS[2]!, '월별로 먼저 더해 볼게요.', [first.line!, second.line!])).line).toBe('월별로 먼저 더해 볼게요.')
    expect(firstLinePrompt('x 정리해줘', true, ['하나 볼게요.', '둘 볼게요.', '셋 볼게요.'])).not.toContain('하나 볼게요.')
  })

  it('never shows a voice line over 60 characters as the acknowledgement (rule 1)', async () => {
    const long = '회의록부터 확인하고 핵심 내용과 결정할 사항을 꼼꼼히 살펴본 다음 담당자별 할 일과 기한을 하나씩 짧게 정리할게요.'
    expect([...long].length).toBe(64)
    expect(ACK_MAX).toBe(60)
    expect(cleanLine(long, ACK_MAX)).toBeUndefined()
    expect((await run(DOCS[0]!, long, [])).shown).toBe(0)
    const edge = '가'.repeat(55) + ' 볼게요.'
    expect([...edge].length).toBe(60)
    expect((await run(DOCS[0]!, edge, [])).line).toBe(edge)
    expect(cleanLine(long)).toBe(long)
    expect(firstLinePrompt('x 정리해줘', true)).toContain('at most 40 characters')
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
      expect((await run(ask, '가격표부터 훑어볼게요.', [])).line, ask).toBe('가격표부터 훑어볼게요.')
      expect((await run(ask, '셋이 나눠서 알아볼게요.', [])).line).toBe('셋이 나눠서 알아볼게요.')
    }
    expect(source('first-line.ts')).not.toMatch(/splitAsk|SPLIT|teamAsk/)
    expect(source('answer.ts')).not.toMatch(/whole|quickQuestion/)
  })
})

describe('a figure that rests on a convention says so (Q2)', () => {
  it('asks the lead to name an unstated convention inside its one-sentence answer, and posts that sentence as written', async () => {
    expect(VOICE).toContain('A one-fact ask gets that fact in one sentence, also when it comes from a file, naming in it any convention it rests on (a common year, a 30-day month)')
    expect(VOICE).toContain('other variant or "if" unless they ask')
    expect(VOICE).not.toContain('31,536,000')
    const draft = '30일 기준으로 한 달은 43,200분이에요.'
    const { posted, told } = await deskTurn(draft, '한 달은 몇 분이야?')
    expect(told).toContain('naming in it any convention it rests on')
    expect(posted).toBe(draft)
    expect(source('first-line.ts')).not.toContain('quickAnswerPrompt')
  })
})

describe('a tidy job answers with counts, not a file list (F1)', () => {
  const F1_ASK = 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘'
  const F1 = ['inbox-dump 폴더를 종류별로 정리했어요.', '', '- PDF 폴더: 6개 — 견적서_A사.pdf, 계약서_초안.pdf, 세금계산서_10월.pdf, 제품소개서.pdf, 출장보고.pdf, 회의자료_1103.pdf', '- 이미지 폴더: 4개 — 로고_시안.png, 영수증_사진.png, 좌석배치도.png, 화면캡처_01.png', '- 문서 폴더: 3개 — 인사말.docx, 주간보고_44주차.docx, 채용공고_초안.docx', '- 엑셀 폴더: 3개 — 연락처목록.xlsx, 재고현황.xlsx, 출장비정산.xlsx', '- 텍스트 폴더: 4개 — wifi_안내.txt, 메모.txt, 전화메모_1112.txt, 할일.txt'].join('\n')

  it('pins the shape and the one move call in what the model is told; the chat turn reshapes nothing', async () => {
    expect(source('file-move.ts')).toContain('up to 500 in one call')
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
    expect(told).toContain('say in a few words what you chose ("팀에 바로 공유할 수 있게 결정사항이랑 할 일로 나눠서 정리했어요.")')
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

  it('pins the open-form choice rule the model gets; the chat turn has no host fix between the model\'s answer and its delivery, and H4\'s offer is the model\'s own line', async () => {
    expect(COLLEAGUE_RULE).toContain('When the ask is loose, decide the way a sensible colleague would and say in a few words what you chose')
    expect((await deskTurn(SHORT, H3_ASK)).told).toContain('never offer a menu of options or ask how they want it when one reasonable choice exists')
    const ipc = source('ipc.ts')
    expect(answerSetInTurn(ipc)).toBe(1)
    expect(ipc.split('\n').filter(line => /result\.answer = /.test(line)).map(line => line.trim())).toEqual([expect.stringContaining('result.answer = answered }')])
    const todo = '- 한서연: 온보딩 화면 시안 확정 (11/20)\n- 오태민: 결제 모듈 교체 일정 수립 (11/24)'
    const H4 = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
    expect((await deskTurn(todo, H4)).posted).toBe(todo)
    expect((await deskTurn(`${todo}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`, H4)).posted).toBe(`${todo}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`)
  })
})

it('stack-6: "할 일만" is asked of the model as that part only; a reply with a 미결 block and a lone heading is posted as written, every task kept', async () => {
  const tasks = ['한서연: 신규 온보딩 화면 시안 확정 — 11월 20일까지', '오태민: 결제 모듈 교체 일정 수립 — 11월 24일까지', '윤가은: 베타 테스터 50명 모집 공지 발송 — 11월 27일까지', '백도현: 4분기 마케팅 예산안 제출 — 12월 1일까지']
  const shown = ['회의록에서 할 일을 뽑아봤어요.', '', '할 일', '', ...tasks, '', '미결', '', '결제 모듈 후보 두 곳 중 어디로 갈지는 견적 받은 뒤 다음 회의에서 결정', '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  const { posted, told } = await deskTurn(shown, ask)
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
  expect(first).not.toMatch(/saidBefore|fallbackLine/)
  expect(source('aside-ipc.ts')).not.toMatch(/saidBefore|splitLine|fallbackLine/)
  expect(answerSetInTurn(ipc)).toBe(1)
  expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  expect(source('answer.ts')).not.toMatch(/deskNote|DESK_NOTE|fileGiven/)
})
