import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Engine, ToolSessionJob } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))

import { answer, openWorld } from '../src/main/answer.js'

const scratch: string[] = []
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'desk-lane-')); scratch.push(dir); return dir }
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const fake = (lead: (job: ToolSessionJob) => Promise<string>): Engine => ({
  id: 'mock',
  desktopToolIsolation: true,
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => ({ answer: await lead(job) }),
}) as unknown as Engine
const answerSource = () => readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')

describe('desk lane', () => {
  it('gives every ask, an everyday one or not, the same full menu and the same call shape', async () => {
    const jobs: { tools: string[]; modelHint?: string; effort?: string }[] = []
    const engine = fake(async job => { jobs.push({ tools: job.tools.map(tool => tool.name), ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}) }); return '해 볼게요.' })
    const asks = ['작업실 화분 물 주는 요일 정해줘', 'fixtures/garden.csv에서 4월 물 사용량 합계 알려줘', 'fixtures/seeds 폴더 파일들 날짜순으로 옮겨줘', '다음 달 원예 모임용 PPT 4장 만들어줘', '온실 환기 순서 정리해서 수진님한테 보내줘']
    for (const ask of asks) await answer(await openWorld(await temp(), engine), ask)
    expect(jobs).toHaveLength(asks.length)
    for (const job of jobs) expect(job).toEqual(jobs[0])
    for (const tool of ['file_read', 'file_move', 'keep_in_mind', 'search_web']) expect(jobs[0]!.tools, tool).toContain(tool)
  })

  it('gives a remember ask and a correction the model turn like any other ask: no host answer before it', async () => {
    const asks: string[] = []
    const engine = fake(async job => { asks.push(job.prompt); return '네, 그렇게 알고 있을게요.' })
    for (const ask of ['우리 집 분리수거는 수요일이야, 잊지 마', '아 수요일 말고 목요일이야', 'Remember that the plants get water on Fridays']) {
      const { result } = await answer(await openWorld(await temp(), engine), ask)
      expect(result?.answer, ask).toBe('네, 그렇게 알고 있을게요.')
    }
    expect(asks).toHaveLength(3)
  })

  it('runs every turn on the caller\'s full tool list with no model hint and no light effort, and keeps the shell', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(answerSource()).toContain('tools: everyTool,')
    for (const gone of ['deskLane', 'deskKind', 'DESK_TOOLS', 'closingBuilds', 'modelHint', 'light: true']) expect(answerSource(), gone).not.toContain(gone)
    expect(ipc).toContain('...(native && !company ? { native } : {}),')
    expect(answerSource()).toContain('...(native ? { native } : {}),')
  })
})

describe('a question about a named file', () => {
  it('a correction after it reaches the model as typed, with the earlier turns, and with the full menu', async () => {
    let told = '', menu: string[] = []
    const engine = fake(async job => { told = [job.system, job.opening, job.prompt].join('\n'); menu = job.tools.map(tool => tool.name); return '5월 물 사용량은 1,310리터예요.' })
    const world = { ...await openWorld(await temp(), engine), history: [{ role: 'user' as const, text: 'fixtures/garden.csv에서 4월 물 사용량 합계 알려줘' }, { role: 'assistant' as const, text: '4월 물 사용량은 1,240리터예요.' }] }
    const { result } = await answer(world, '아 4월 말고 5월 걸로')
    expect(result?.answer).toBe('5월 물 사용량은 1,310리터예요.')
    expect(told).toContain('Task: 아 4월 말고 5월 걸로')
    expect(told).toContain('fixtures/garden.csv에서 4월 물 사용량 합계 알려줘')
    expect(told).toContain('4월 물 사용량은 1,240리터예요.')
    expect(told).not.toContain('The person then changed it')
    expect(told).not.toContain('the later words hold')
    for (const tool of ['file_read', 'file_read_workbook', 'find_files', 'file_move', 'keep_in_mind']) expect(menu, tool).toContain(tool)
  })

  it('leaves a file the person names to the model\'s own file_read: the prompt holds none of its text', async () => {
    let told = '', menu: string[] = []
    const engine = fake(async job => { told = [job.system, job.opening, job.prompt].join('\n'); menu = job.tools.map(tool => tool.name); return '4월에는 토마토 모종을 심었어요.' })
    const world = await openWorld(await temp(), engine)
    await mkdir(join(world.paths.workspace, 'fixtures'), { recursive: true })
    await writeFile(join(world.paths.workspace, 'fixtures', 'garden-log.md'), '# 텃밭 일지\n- 4월 둘째 주: 토마토 모종 여섯 포기\n')
    const { result } = await answer(world, 'fixtures/garden-log.md에 4월에 뭐 심었다고 돼 있어?')
    expect(result?.answer).toBe('4월에는 토마토 모종을 심었어요.')
    expect(told).toContain('fixtures/garden-log.md')
    expect(told).not.toContain('토마토 모종 여섯 포기')
    expect(told).not.toContain('is already read for you')
    expect(told).not.toContain('<<<garden-log.md')
    expect(menu).toContain('file_read')
  })
})

describe('document and tidy answers', () => {
  const core = (name: string) => readFileSync(new URL(`../../../packages/core/src/${name}`, import.meta.url), 'utf8')
  it('closes a document turn with one or two sentences and no list of contents', () => {
    expect(core('agent-voice.ts')).toContain('never a list of its sections, slides, sheets or contents')
    expect(core('agent-session-shape.ts')).toContain('never a list of its sections, slides, sheets or contents')
  })
  it('asks for the offer in one place only, at most once across document turns, and exactly once after an extraction', () => {
    const voice = core('agent-voice.ts')
    expect(voice.match(/ONE short offer line/g)).toHaveLength(1)
    expect(voice).toContain('An extraction from a file ("할 일만 뽑아줘") ends with exactly ONE short offer line')
    expect(voice).toContain('never as a "(참고: …)" note or an aside')
    expect(voice).toContain('document turns in a row carry at most one offer between them')
  })
})
