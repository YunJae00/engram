import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolSession, type AgentLoopOptions, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'

async function turn(draft: string, said: string, options: AgentLoopOptions = {}) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return '{"problems":[]}' } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c16c-desk' as EngineCwd, tools: [] }, said, options)
  return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
}
async function deskTurn(draft: string, said: string, file: { name: string; text: string }) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = [], seen: string[] = []
  const read: AgentTool = { name: 'file_read', description: 'reads a saved file', argsSchema: { type: 'object' }, run: async args => args['path'] === file.name ? file.text : '' }
  const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, quick: async (prompt: string) => { voiced.push(prompt); return '{"problems":[]}' }, runTools: async (job: ToolSessionJob) => {
    jobs.push(job)
    const out = await job.tools.find(tool => tool.name === 'file_read')!.run({ path: file.name })
    seen.push(typeof out === 'string' ? out : out.text)
    return { answer: draft }
  } } as unknown as Engine
  const dir = await mkdtemp(join(tmpdir(), 'c16c-desk-'))
  try {
    const { result } = await answer(await openWorld(dir, engine), said, { tools: [read], ack: { interactive: false } })
    return { posted: result!.answer, calls: jobs.length, voiced, seen: seen.join('\n'), told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const SOURCE = '# 킥오프 메모\n\n## 이야기한 것\n- 출시는 3월로 가자는 데 모두 동의했다.\n- 외주 디자이너 일정이 밀리면 출시가 늦어질 수 있다.\n\n## 합의\n1. 요구사항 문서 작성 — 담당: 이수진, 기한: 12월 5일\n2. 디자이너 계약 — 담당: 박준호, 기한: 12월 8일\n'
const ASK = '프로젝트 킥오프 메모 정리해서 합의된 것, 리스크, 다음 단계로 나눠줘'
const DRAFT = '합의된 것\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일'
const FIXED = '합의된 것\n- 출시는 3월\n\n리스크\n- 디자이너 일정이 밀리면 출시가 늦어질 수 있어요\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일'

describe('a part the ask names and the answer lacks is "missing" (D1 class)', () => {
  it('the model reads the source with its own file_read, and the answer it writes with all three parts is posted as written', async () => {
    const { posted, told, seen, calls, voiced } = await deskTurn(FIXED, ASK, { name: 'kickoff.md', text: SOURCE })
    expect(seen).toContain(SOURCE)
    expect(told).not.toContain(SOURCE)
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
    expect(told).toContain('every fact and constraint kept, no value guessed, nothing about the change')
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
  it('the model has the whole file from its own file_read, none of it pre-read into the prompt, and its one line is posted as written', async () => {
    const { posted, told, seen, voiced } = await deskTurn(oneLine, ask, { name: 'workshop.md', text: memo })
    expect(seen).toContain(memo)
    expect(told).not.toContain('<<<workshop.md')
    expect(told).not.toContain('테스트 서버 상태를 매일 아침 확인하기로')
    expect(posted).toBe(oneLine)
    expect(voiced).toEqual([])
    expect((await deskTurn(fixed, ask, { name: 'workshop.md', text: memo })).posted).toBe(fixed)
    expect(lacks).toContain('missing')
  })
  it('a one-line answer (no named source) is delivered as written, with no voice call', async () => {
    const quick = vi.fn(async () => lacks)
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async () => ({ answer: '아침 9시에 열어요.' }), quick } as unknown as Engine
    expect((await runToolSession({ engine, workdir: '/tmp/c16c-desk' as EngineCwd, tools: [] }, '동네 도서관 문 여는 때가 언제야?')).answer).toBe('아침 9시에 열어요.')
    expect(quick).not.toHaveBeenCalled()
  })
})
