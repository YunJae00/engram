import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import type { Engine, ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
import { answer, openWorld } from '../src/main/answer.js'
const DESK_FUNCTIONS = ['fixSlideTitle', 'keepAsk', 'keptFix', 'kindSortAsk', 'plainKeep', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const SOURCE = [
  '# 영업팀 11월 월간 회의', '',
  '## 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '',
  '## 액션', '- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일', '',
  '## 미결', '- 판촉물 업체는 다음 주에 확정한다.',
].join('\n')
const ASK = '영업팀 회의록 sales-nov.md에서 주요 결정이랑 담당자별 업무만 뽑아줘'
const DRAFT = ['영업팀 11월 회의에서 주요 결정과 담당자별 업무를 뽑았어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸'].join('\n')
const TASKS = ['- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일']
async function deskTurn(draft: string, source = SOURCE) {
  const jobs: ToolSessionJob[] = [], read: string[] = []
  let named = ''
  const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => {
    jobs.push(job)
    read.push(await job.tools.find(tool => tool.name === 'file_read')!.run({ path: named }, { task: ASK }))
    return { answer: draft }
  } } as unknown as Engine
  const dir = await mkdtemp(join(tmpdir(), 'c18b-desk-')); scratch.push(dir)
  const world = await openWorld(dir, engine)
  named = join(world.paths.workspace, 'sales-nov.md')
  await writeFile(named, source)
  const { result } = await answer(world, ASK)
  return { posted: result!.answer, calls: jobs.length, read, menu: jobs.flatMap(job => job.tools.map(tool => tool.name)), told: jobs.map(job => `${job.system}\n${job.opening ?? ''}\n${job.prompt}`).join('\n') }
}
const draftLines = (out: string): string[] => out.split('\n').filter(line => DRAFT.split('\n').includes(line))

describe('a missing named part is the model\'s to write, never the host\'s to insert', () => {
  it('a draft without 담당자별 업무 is posted with every line as it was, and no repair is asked for', async () => {
    const { posted, calls } = await deskTurn(DRAFT)
    expect(posted).toBe(DRAFT)
    expect(draftLines(posted).filter(Boolean)).toEqual(DRAFT.split('\n').filter(Boolean))
    expect(calls).toBe(1)
  })

  it('the turn carries the ask with its named parts as typed, and the answer with both parts is posted byte for byte', async () => {
    const whole = `${DRAFT}\n\n담당자별 업무\n${TASKS.join('\n')}`
    const { posted, told } = await deskTurn(whole)
    expect(told).toContain(ASK)
    expect(told).not.toContain('the answer has each of those parts as its own part, under the name they used')
    expect(posted).toBe(whole)
    for (const task of TASKS) expect(posted).toContain(task)
  })

  it('the model is told to add nothing that is not in the file, and reads the file with its own call: nothing of it is pre-read into the turn', async () => {
    const { posted, told, read, menu } = await deskTurn(DRAFT)
    expect(told).toContain('holds only what is in it: add no item, number, owner, date or open question that is not there')
    expect(menu).toContain('file_read')
    expect(told).not.toContain('<<<sales-nov.md')
    expect(told).not.toContain(TASKS[0])
    expect(read[0]).toContain(TASKS[0])
    for (const line of posted.split('\n').filter(line => line.startsWith('- '))) expect(SOURCE).toContain(line)
  })
})

describe('r2: where a line belongs is said in the rules, and the host moves no line', () => {
  it('tasks written under 결정 are posted where the model put them, and the rule says an item is listed once', async () => {
    const misplaced = [...DRAFT.split('\n'), ...TASKS].join('\n')
    const { posted, told } = await deskTurn(misplaced)
    expect(posted).toBe(misplaced)
    expect(told).toContain('A decision or item is listed once, never again under a second heading.')
    for (const task of TASKS) expect(posted.split(task)).toHaveLength(2)
  })
  it('the mover, the checker and the desk note are gone from the desk lane: only the keep, slide-title and sort answers are left', () => {
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    expect(Object.keys(deskLane)).not.toContain('DESK_NOTE')
    expect(Object.keys(deskLane)).not.toContain('DESK_TOOLS')
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
