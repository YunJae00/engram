import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { runToolSession, type AgentLoopOptions, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { DESK_NOTE, fileGiven } from '../src/main/desk-lane.js'

async function turn(draft: string, said: string, options: AgentLoopOptions = {}) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return '{"problems":[]}' } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c16c-desk' as EngineCwd, tools: [] }, said, options)
  return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
}
const deskTurn = (draft: string, said: string, file: { name: string; text: string }) => turn(draft, said, { attachmentContext: [DESK_NOTE, fileGiven(file)].join('\n\n') })

const SOURCE = '# 킥오프 메모\n\n## 이야기한 것\n- 출시는 3월로 가자는 데 모두 동의했다.\n- 외주 디자이너 일정이 밀리면 출시가 늦어질 수 있다.\n\n## 합의\n1. 요구사항 문서 작성 — 담당: 이수진, 기한: 12월 5일\n2. 디자이너 계약 — 담당: 박준호, 기한: 12월 8일\n'
const ASK = '프로젝트 킥오프 메모 정리해서 합의된 것, 리스크, 다음 단계로 나눠줘'
const DRAFT = '합의된 것\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일'
const FIXED = '합의된 것\n- 출시는 3월\n\n리스크\n- 디자이너 일정이 밀리면 출시가 늦어질 수 있어요\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일'
const PARTS = 'When they name the parts of the answer (sections, columns, categories, a number of items), the answer has each of those parts as its own part, under the name they used'

describe('a part the ask names and the answer lacks is "missing" (D1 class)', () => {
  it('the turn is told to give every named part, and the answer the model writes with all three parts is posted as written', async () => {
    const { posted, told, calls, voiced } = await deskTurn(FIXED, ASK, { name: 'kickoff.md', text: SOURCE })
    expect(told).toContain(PARTS)
    expect(told).toContain(SOURCE)
    expect(posted).toBe(FIXED)
    for (const part of ['합의된 것', '리스크', '다음 단계']) expect(posted).toContain(part)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('a draft that lacks a part is posted as it was: nothing is added to it and it is never withheld', async () => {
    const { posted, calls, voiced } = await deskTurn(DRAFT, ASK, { name: 'kickoff.md', text: SOURCE })
    expect(posted).toBe(DRAFT)
    expect(posted).not.toContain('리스크')
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('the desk note gives the parts the ask names, filled by meaning over the source\'s headings', () => {
    expect(DESK_NOTE).toContain('When they name the parts of the answer')
    expect(DESK_NOTE).toContain('even when the source labels it otherwise')
  })
})

describe('a reshape keeps the facts of the earlier ask (Q4 class)', () => {
  const EARLIER = '"택배 늦게 보내서 죄송합니다"를 정중한 영어 한 줄로 써줘'
  const LAST = '이렇게 쓰시면 돼요. "I sincerely apologize for the delay in sending your package."'
  const was = 'I sincerely apologize for the delay in sending your package.'
  const say = (reply: string): string => JSON.stringify({ form: 'simpler', was, reply })
  const lost = 'I apologize for the delay.', kept = 'Sorry your package was sent late.'
  const thread = [{ role: 'user' as const, text: EARLIER }, { role: 'assistant' as const, text: LAST }]
  it('the model is told that another form keeps every fact of the original ask, with that ask in view', async () => {
    const { told } = await turn(say(kept), '더 간단히', { history: thread })
    expect(told).toContain('with every fact and every constraint of the original ask kept, and nothing about what you changed')
    expect(told).toContain(EARLIER)
    expect(told).toContain(was)
  })
  it('a reply without the parcel is posted as the model wrote it: no "dropped" check, no rewrite', async () => {
    const { posted, calls, voiced } = await turn(lost, '더 간단히', { history: thread })
    expect(posted).toBe(lost)
    expect(posted).not.toBe(kept)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
})

describe('a one-line answer drawn from a named file is checked too (Codex r1 #1)', () => {
  const memo = '# 워크숍 메모\n- 배포가 늦어진 건 테스트 서버가 하루 내내 꺼져 있어서였다.\n- 앞으로 테스트 서버 상태를 매일 아침 확인하기로 했다 — 담당: 오하늘'
  const ask = '워크숍 메모 원인이랑 대책으로 나눠서 정리해줘'
  const oneLine = '배포가 늦어진 건 테스트 서버가 하루 꺼져 있어서였어요.'
  const fixed = '원인: 테스트 서버가 하루 내내 꺼져 있었어요.\n대책: 오하늘 님이 매일 아침 서버 상태를 확인해요.'
  const lacks = JSON.stringify({ problems: [{ kind: 'missing', quote: '대책', why: '대책이 없어요' }] })
  it('the model has the whole file and the rule on named parts, and its one line is posted as written', async () => {
    const { posted, told, voiced } = await deskTurn(oneLine, ask, { name: 'workshop.md', text: memo })
    expect(told).toContain(`<<<workshop.md\n${memo}\n>>>`)
    expect(told).toContain(PARTS)
    expect(posted).toBe(oneLine)
    expect(voiced).toEqual([])
    expect((await deskTurn(fixed, ask, { name: 'workshop.md', text: memo })).posted).toBe(fixed)
    expect(lacks).toContain('missing')
  })
  it('a one-line short-ask answer (no named source) is delivered as written, with no voice call', async () => {
    const quick = vi.fn(async () => lacks)
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async () => ({ answer: '아침 9시에 열어요.' }), quick } as unknown as Engine
    expect((await runToolSession({ engine, workdir: '/tmp/c16c-desk' as EngineCwd, tools: [] }, '동네 도서관 문 여는 때가 언제야?', { short: true })).answer).toBe('아침 9시에 열어요.')
    expect(quick).not.toHaveBeenCalled()
  })
})
