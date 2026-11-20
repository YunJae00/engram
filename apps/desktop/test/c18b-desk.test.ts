import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()

const SOURCE = [
  '# 영업팀 11월 월간 회의', '',
  '## 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '',
  '## 액션', '- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일', '',
  '## 미결', '- 판촉물 업체는 다음 주에 확정한다.',
].join('\n')
const ASK = '영업팀 회의록에서 주요 결정이랑 담당자별 업무만 뽑아줘'
const DRAFT = ['영업팀 11월 회의에서 주요 결정과 담당자별 업무를 뽑았어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸'].join('\n')
const TASKS = ['- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일']
async function deskTurn(draft: string, source = SOURCE) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return '{"problems":[]}' } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c18b-desk' as EngineCwd, tools: [] }, ASK, { attachmentContext: [deskLane.DESK_NOTE, deskLane.fileGiven({ name: 'sales-nov.md', text: source })].join('\n\n') })
  return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}`).join('\n') }
}
const draftLines = (out: string): string[] => out.split('\n').filter(line => DRAFT.split('\n').includes(line))

describe('a missing named part is the model\'s to write, never the host\'s to insert', () => {
  it('a draft without 담당자별 업무 is posted with every line as it was, and no repair is asked for', async () => {
    const { posted, calls, voiced } = await deskTurn(DRAFT)
    expect(posted).toBe(DRAFT)
    expect(draftLines(posted).filter(Boolean)).toEqual(DRAFT.split('\n').filter(Boolean))
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })

  it('the turn is told to give each named part under the name they used, and the answer with both parts is posted byte for byte', async () => {
    const whole = `${DRAFT}\n\n담당자별 업무\n${TASKS.join('\n')}`
    const { posted, told } = await deskTurn(whole)
    expect(told).toContain('the answer has each of those parts as its own part, under the name they used')
    expect(posted).toBe(whole)
    for (const task of TASKS) expect(posted).toContain(task)
  })

  it('the model is told to add nothing that is not in the file, and has the file itself to copy from', async () => {
    const { posted, told } = await deskTurn(DRAFT)
    expect(told).toContain('holds only what is in it: add no item, number, owner, date or open question that is not there')
    expect(told).toContain(`<<<sales-nov.md\n${SOURCE}\n>>>`)
    for (const line of posted.split('\n').filter(line => line.startsWith('- '))) expect(SOURCE).toContain(line)
  })
})

describe('r2: where a line belongs is said in the rules, and the host moves no line', () => {
  it('tasks written under 결정 are posted where the model put them, and the rule says each thing goes under one part only', async () => {
    const misplaced = [...DRAFT.split('\n'), ...TASKS].join('\n')
    const { posted, told } = await deskTurn(misplaced)
    expect(posted).toBe(misplaced)
    expect(told).toContain('Each thing goes under one of them, never both: an item with an owner and a due date is an action item.')
    expect(told).toContain('A decision or item is listed once, never again under a second heading.')
    for (const task of TASKS) expect(posted.split(task)).toHaveLength(2)
  })
  it('the mover and the checker are gone from the desk lane, and an empty heading is the model\'s to leave out', () => {
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    expect(deskLane.DESK_NOTE).toContain('a heading with nothing of its own is left out')
    expect(deskLane.DESK_NOTE).toContain('fills each with what belongs there by meaning, even when the source labels it otherwise or puts it under another heading')
  })
})

describe('register of copied lines', () => {
  it('the -요 form is asked of the model for the whole reply, and a copied "…확정한다." line is posted byte-equal with every other line', async () => {
    const draft = `${DRAFT}\n\n미결\n- 판촉물 업체는 다음 주에 확정한다.`
    const { posted, told } = await deskTurn(draft)
    expect(told).toContain('in Korean keep the polite-casual -요 form through the whole reply')
    const before = draft.split('\n'), after = posted.split('\n')
    expect(after).toHaveLength(before.length)
    after.forEach((line, i) => expect(line).toBe(before[i]))
  })
})
