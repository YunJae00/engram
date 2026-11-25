import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { runToolSession, type AgentLoopOptions, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { DESK_NOTE, DESK_TOOLS } from '../src/main/desk-lane.js'
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await answer({'), ipc.indexOf('answerDelivered = true')).split('result.answer = ').length - 1
import { PRELOADED_TOOLS_MAX } from '../src/main/engine-claude-session.js'
import { SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'
import { ACK_MAX, fallbackLine, firstLinePrompt, saidBefore } from '../src/main/first-line.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
async function turn(draft: string, said: string, options: AgentLoopOptions) {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c7c-voice' as EngineCwd, tools: [] }, said, options)
  return { posted: result.answer, told: jobs.map(job => `${job.system}\n${job.prompt}`).join('\n') }
}
const noteAnswer = async (ask: string, answer: string) => (await turn(answer, ask, { attachmentContext: DESK_NOTE })).posted
const shortAnswer = async (answer: string) => (await turn(answer, '매표소 창구는 어느 쪽이야?', { short: true, attachmentContext: SHORT_QUESTION_NOTE })).posted

describe('the words of a slide are changed without XML (D5)', () => {
  it('tells the deck kind to use the outline and the slide edits, inside the same menu', () => {
    expect(DESK_NOTE).toContain('never read or write slide XML')
    expect(DESK_NOTE).toContain('file_read_package outline:true')
    expect(DESK_NOTE).toContain('{slide, with} for a title or {slide, text, with} for another text')
    expect(DESK_NOTE).toContain('Only a change to the structure')
    for (const tool of ['file_read_package', 'file_edit_package']) expect(DESK_TOOLS.deck!.has(tool)).toBe(true)
    expect(DESK_TOOLS.deck!.size).toBeLessThanOrEqual(PRELOADED_TOOLS_MAX)
  })
})

describe('decisions and tasks are said once (D1)', () => {
  const D1_ASK = 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘'
  const D1 = ['회의록 요약해서 정리해볼게요.', '', '결정사항', '', '신규 온보딩 화면은 B안으로 확정 — 담당: 한서연, 기한: 11월 20일', '결제 모듈 교체 일정 수립 — 담당: 오태민, 기한: 11월 24일', '베타 테스터 50명 모집 공지 발송 — 담당: 윤가은, 기한: 11월 27일', '4분기 마케팅 예산안 제출 — 담당: 백도현, 기한: 12월 1일', '',
    '할 일', '', '한서연: 온보딩 화면 시안 확정 (11/20까지)', '오태민: 결제 모듈 교체 일정 수립 (11/24까지)', '윤가은: 베타 테스터 50명 모집 공지 발송 (11/27까지)', '백도현: 광고비·행사비 나눠서 마케팅 예산안 재정리 후 제출 (12/1까지)', '', '미결', '', '결제 모듈 후보 두 곳 중 어디로 갈지는 견적 받은 뒤 다음 회의(11/23)에서 결정'].join('\n')

  it('the model is told to open on the answer and to say each thing under one part; a draft with a promise line and owner / date tails under 결정사항 is posted as written', async () => {
    const { posted, told } = await turn(D1, D1_ASK, { attachmentContext: DESK_NOTE })
    expect(told).toContain('The answer is the first line: no opening line about what you are about to do')
    expect(told).toContain('Each thing goes under one of them, never both: an item with an owner and a due date is an action item.')
    expect(posted).toBe(D1)
    expect(posted.startsWith(D1.split('\n')[0]!)).toBe(true)
    expect(posted.match(/담당: /g)).toHaveLength(4)
    const marked = D1.replace(/^(결정사항|할 일|미결)$/gm, '**$1**').replace(/^(?!\*\*|회의록 요약|$)(.+)$/gm, '- $1')
    expect(await noteAnswer(D1_ASK, marked)).toBe(marked)
    const clean = D1.split('\n').slice(2).map(line => line.replace(/ — 담당: .+$/, '')).join('\n')
    expect(await noteAnswer(D1_ASK, clean)).toBe(clean)
  })

  it('keeps a tail whose owner or date no 할 일 line carries, and an ask for the decisions alone', async () => {
    const other = D1.replace('(11/20까지)', '(11/21까지)').replace('— 담당: 오태민,', '— 담당: 정하윤,')
    const out = await noteAnswer(D1_ASK, other)
    expect(out).toContain('신규 온보딩 화면은 B안으로 확정 — 담당: 한서연, 기한: 11월 20일')
    expect(out).toContain('결제 모듈 교체 일정 수립 — 담당: 정하윤, 기한: 11월 24일')
    expect(out).toBe(other)
    expect(await noteAnswer('메모에서 정해진 것만 골라줘', D1)).toBe(D1)
    const alone = D1.slice(0, D1.indexOf('할 일')).trimEnd()
    expect(await noteAnswer(D1_ASK, alone)).toBe(alone)
    const bare = '결정사항\n- 담당: 한서연, 기한: 11월 20일\n\n할 일\n- 한서연: 시안 확정 (11/20까지)'
    expect(await noteAnswer(D1_ASK, bare)).toBe(bare)
  })

  it('leaves H3 and H4 of this run as the model wrote them, a promise line in front included', async () => {
    const H3_ASK = 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘'
    const H3 = ['할 일 위주로 짧게 정리했고, 결정사항과 미결을 나눠서 담았어요.', '', '결정사항 (11/16 회의)', '', '온보딩 화면은 B안으로 가는 쪽에 의견이 모였어요 — 한서연, 11/20', '결제 모듈 교체 일정 수립 — 오태민, 11/24', '베타 테스터 50명 모집 공지 — 윤가은, 11/27', '4분기 마케팅 예산안 제출 — 백도현, 12/1', '', '미결', '', '결제 모듈 후보 두 곳 중 선택은 견적 받은 뒤 다음 회의(11/23)에서 결정'].join('\n')
    expect(await noteAnswer(H3_ASK, H3)).toBe(H3)
    expect(await noteAnswer(H3_ASK, `돌려 보기 편하게 다듬어 볼게요.\n\n${H3}`)).toBe(`돌려 보기 편하게 다듬어 볼게요.\n\n${H3}`)
    const H4_ASK = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
    const H4 = ['회의록에서 할 일을 뽑았어요.', '', '한서연: 신규 온보딩 화면 시안 확정 — 11월 20일', '오태민: 결제 모듈 교체 일정 수립 — 11월 24일', '윤가은: 베타 테스터 50명 모집 공지 발송 — 11월 27일', '백도현: 4분기 마케팅 예산안 제출 — 12월 1일', '', '원하시면 담당자별로 표로 정리해 드릴게요.'].join('\n')
    expect(await noteAnswer(H4_ASK, H4)).toBe(H4)
    expect(await noteAnswer(D1_ASK, '지금 정리해볼게요.')).toBe('지금 정리해볼게요.')
  })

  it('no correction is called on a desk note answer: the chat turn posts it, and the repeat check stays with the quick voice', () => {
    const ipc = source('ipc.ts')
    expect(answerSetInTurn(ipc)).toBe(1)
    expect(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result, nativeSince, request.message)')).toBeLessThan(ipc.indexOf('`${result.asked ? askText(result.answer, result.options) : result.answer}${note}`,'))
    const first = source('first-line.ts')
    expect(first.slice(first.indexOf('export const laneLine'), first.indexOf('const FILE_WORK ='))).not.toContain('saidBefore')
    expect(source('fast-lane.ts')).not.toContain('saidBefore')
  })
})

describe('first lines in a thread do not share a frame (D4, D3, D5)', () => {
  it('counts a second "…부터" line and the closing verb of the line before as a repeat', () => {
    expect(saidBefore('매출 데이터부터 정리할게요.', ['보고서 구성부터 잡을게요.'])).toBe(true)
    expect(saidBefore('슬라이드 흐름부터 짜볼게요.', ['보고서 구성부터 잡을게요.'])).toBe(true)
    expect(saidBefore('엑셀로 바로 묶어 볼게요.', ['보고서 구성부터 잡을게요.'])).toBe(false)
    expect(saidBefore('3번 슬라이드 제목 바꿀게요.', ['보고서 구성부터 잡을게요.', '엑셀로 바로 묶어 볼게요.'])).toBe(false)
    expect(saidBefore('차트까지 넣어 볼게요.', ['엑셀로 바로 묶어 볼게요.'])).toBe(true)
    expect(saidBefore('차트까지 넣어 볼게요.', ['엑셀로 바로 묶어 볼게요.', '3번 슬라이드 제목 바꿀게요.'])).toBe(false)
    expect(saidBefore('보고서 구성부터 잡을게요.', [])).toBe(false)
    expect(saidBefore('매출 데이터부터 정리할게요.', ['지금 시세 확인할게요.'])).toBe(false)
  })

  it('the host line after a "…부터" line is built another way, for every kind of ask', () => {
    const asks = ['fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', '방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘', '위 회의록으로 워드 보고서 만들어줘', '점심 메뉴 하나만 골라줘', '이거 영어로 번역해줘', '회의록 요약해줘', '이게 뭐야?', '그냥 해']
    for (const ask of asks) for (const said of [['보고서 구성부터 잡을게요.'], ['보고서 구성부터 잡을게요.', '슬라이드 흐름 짜볼게요.'], ['파일 먼저 열어 볼게요.', '보고서 구성부터 잡을게요.'], ['보고서 구성부터 잡을게요.', '보내주신 것 먼저 살필게요.', '지금 고쳐 볼게요.']]) {
      const line = fallbackLine(ask, true, said)
      expect(line, `${ask} after ${said.join(' ')}`).not.toContain('부터')
      expect(saidBefore(line, said), `${ask}: ${line}`).toBe(false)
      expect([...line].length).toBeLessThanOrEqual(ACK_MAX)
    }
    expect(fallbackLine('fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', true)).toBe('파일부터 확인할게요.')
  })

  it('tells the voice which frame is used up and shows other builds', () => {
    const fresh = firstLinePrompt('위 회의록으로 워드 보고서 만들어줘', true)
    expect(fresh).not.toContain('Your first lines earlier')
    const later = firstLinePrompt('fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', true, ['보고서 구성부터 잡을게요.'])
    for (const said of ['"보고서 구성부터 잡을게요."', '"엑셀로 바로 묶어 볼게요."', '"3번 슬라이드 제목 바꿀게요."', '"차트까지 넣어서 만들게요."', 'this one has no 부터 in it', 'does not end on the last word of the line before it']) expect(later, said).toContain(said)
    expect(firstLinePrompt('회의록 요약해줘', true, ['지금 시세 확인할게요.'])).not.toContain('this one has no 부터 in it')
  })

  it('touches only the quick voice line and its fallback', () => {
    const first = source('first-line.ts')
    expect(first.slice(first.indexOf('export const laneLine'), first.indexOf('const FILE_WORK ='))).not.toContain('saidBefore')
    expect(source('fast-lane.ts')).not.toContain('saidBefore')
  })
})

describe('a fact about the person is a state, not an instruction (M3, c11b)', () => {
  it('turns a closing -하세요 on a who / what / where question about them into -하고 계세요 (c11b: asked of the model, no host rewrite)', async () => {
    expect(SHORT_QUESTION_NOTE).toContain('never with an ending that reads as telling them to do it')
    for (const answer of ['민호 님이랑 일하세요.', '판교 사무실에서 근무하시죠', '민호 님이요.']) expect(await shortAnswer(answer), answer).toBe(answer)
  })
  it('leaves an instruction they asked for, an offer and a question about someone else (c11b: every answer is left as written)', async () => {
    for (const answer of ['목을 천천히 돌리면서 시작하세요.', '목 돌리기부터 시작하세요.', '민호 님이랑 일하고 계세요. 더 궁금한 거 있으면 말씀하세요.', '디자인을 담당하세요.', '칼국수를 하세요.']) expect(await shortAnswer(answer), answer).toBe(answer)
  })
  it('is said that way in the note and checked on short answers, with no word about memory (c11b: no template phrase)', () => {
    expect(SHORT_QUESTION_NOTE).toContain('in one short, plain sentence the way a colleague would say it back')
    expect(SHORT_QUESTION_NOTE).toContain('with no word about remembering or looking it up')
    for (const template of ['같이 일하고 계세요', '살고 계세요']) expect(SHORT_QUESTION_NOTE).not.toContain(template)
    expect(source('ipc.ts')).not.toContain('asState')
  })
})

describe('a pick comes with its reason, recommendations with what they went by (H1)', () => {
  it('says so in the short-ask note and keeps the rules Q2-Q4 and H2 ride on', () => {
    for (const said of ['A pick ("하나만 골라줘") is the thing itself and half a clause of why', '"칼국수 어때요? 쌀쌀하니까요."', 'for a menu a dish, never a kind of restaurant', 'each with half a clause of why it fits what they told you', 'numbered when there are three or more', 'still no question back', 'fitting what they told you earlier about the thing asked',
      'Asked for one thing, give exactly one; asked for three, give three', 'a line or a name is given as just that', 'so the reply is never the foreign line alone', '"평년 기준으로 31,536,000초예요."', 'names it in the conversation\'s own words and, for picks, says what you went by ("제주 가시면 아버님 무릎 생각해서 덜 걷는 걸로 골랐어요."', 'you never ask which one they mean']) expect(SHORT_QUESTION_NOTE, said).toContain(said)
    expect(SHORT_QUESTION_NOTE).not.toContain('a pick is given as just that')
  })
  it('keeps a recommendation\'s lead and every pick under it: nothing is taken off a short answer', async () => {
    const picks = '아버님 무릎 생각해서 많이 안 걷는 걸로 골랐어요.\n\n1. 제주 가시면 해안도로 드라이브가 좋아요.\n2. 오설록 티뮤지엄은 실내라 편해요.\n3. 함덕 해변 카페에서 쉬어 가세요.'
    expect(await shortAnswer(picks)).toBe(picks)
    expect(await shortAnswer(`세 군데 골라 드릴게요.\n\n${picks}`)).toBe(`세 군데 골라 드릴게요.\n\n${picks}`)
  })
})
