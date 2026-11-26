import { readFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileWorkTools, HOUSE_THEME, loadBotMemory, PERSON_MEMORY, PROFILE_NOTE_ID, profileLines, resolveTheme, type Engine, type ToolSessionJob, type VaultPaths } from 'core'

const fake = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.directory, isPackaged: false }, shell: { openPath: async () => '' }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { answer, openWorld } from '../src/main/answer.js'
import { quickPrompt } from './ack-prompt.js'
import { buildDeck } from '../src/main/deck-render.js'
import { learningTools } from '../src/main/learning-wiring.js'

const require = createRequire(resolve('packages/core/package.json'))
const JSZip = require('jszip') as typeof import('../../../packages/core/node_modules/jszip')

let root: string
beforeEach(async () => { await mkdir(resolve('tmp'), { recursive: true }); root = await mkdtemp(resolve('tmp/c8c-desk-')); fake.directory = root })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const lead = (draft: (job: ToolSessionJob) => string): { engine: Engine; jobs: ToolSessionJob[] } => {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft(job) } } } as unknown as Engine
  return { engine, jobs }
}
const worldIn = async (name: string, engine: Engine) => { const dir = join(root, name); await mkdir(dir, { recursive: true }); return openWorld(dir, engine) }

const deck = async () => {
  const built = await buildDeck({ theme: HOUSE_THEME, slides: [{ title: '3분기 실적 보고', subtitle: '다음 주 팀 회의용' }, { title: '요약', bullets: ['매출: 수치 입력', '영업이익: 수치 입력'] }, { title: '주요 지표', bullets: ['전년 대비 성장률: 수치 입력'] }] })
  const path = join(root, built.name)
  await writeFile(path, built.data)
  return { name: built.name, path }
}
const slideText = async (path: string, slide: number) => (await (await JSZip.loadAsync(await readFile(path))).file(`ppt/slides/slide${slide}.xml`)!.async('string'))
const tools = (approveRead: () => Promise<boolean> = async () => true) => fileWorkTools({ directory: join(root, 'outputs'), approveRead: approveRead as never })

describe('a slide title is changed by the model\'s own read and edit calls (D5)', () => {
  const retitle = (slide: number, title: string, made: { name: string; path: string }) => async (job: ToolSessionJob) => {
    const call = (name: string) => job.tools.find(tool => tool.name === name)!
    const seen = String(await call('file_read_package').run({ path: made.path, outline: true }, {}))
    const outline = { sha256: /"sha256":"([0-9a-f]{64})"/.exec(seen)![1]! }
    await call('file_edit_package').run({ sourcePath: made.path, expectedSha256: outline.sha256, name: made.name, edits: [{ slide, with: title }] }, {})
  }
  it('edits the deck through the model\'s calls and stores the model\'s words', async () => {
    const made = await deck(), jobs: ToolSessionJob[] = []
    const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); await retitle(3, '눈여겨볼 숫자', made)(job); return { answer: '세 번째 장 제목을 "눈여겨볼 숫자"로 바꿨어요.' } } } as unknown as Engine
    const world = await worldIn('w', engine)
    const { result, failure } = await answer(world, '그 발표자료 셋째 장 머리말 "눈여겨볼 숫자"로 해줘', { tools: tools() })
    expect(failure).toBeUndefined()
    expect(jobs).toHaveLength(1)
    expect(result?.answer).toBe('세 번째 장 제목을 "눈여겨볼 숫자"로 바꿨어요.')
    expect(result?.steps.map(step => step.tool)).toEqual(['file_read_package', 'file_edit_package'])
    const receipt = JSON.parse(result!.steps[1]!.observation.split('\n')[0]!) as { path: string; changedParts: string[] }
    expect(receipt.changedParts).toEqual(['ppt/slides/slide3.xml'])
    const xml = await slideText(receipt.path, 3)
    expect(xml).toContain('<a:t>눈여겨볼 숫자</a:t>')
    expect(xml).not.toContain('주요 지표')
    expect(xml).toContain('전년 대비 성장률: 수치 입력')
    expect(world.history.at(-1)).toEqual({ role: 'assistant', text: '세 번째 장 제목을 "눈여겨볼 숫자"로 바꿨어요.' })
  })
  it('writes nothing when the model makes no edit call: the host never edits a deck on its own', async () => {
    const made = await deck(), before = await readFile(made.path), { engine, jobs } = lead(() => '어느 장인지 다시 볼게요.')
    const { result } = await answer(await worldIn('w', engine), '2번 장 제목을 \'모임 순서\'로 고쳐', { tools: tools() })
    expect(jobs).toHaveLength(1)
    expect(result?.answer).toBe('어느 장인지 다시 볼게요.')
    expect(await readdir(join(root, 'outputs')).catch(() => [])).toEqual([])
    expect(await readFile(made.path)).toEqual(before)
  })
})

describe('which desk turns think briefly (D5, F1)', () => {
  it('a change to a document that exists and a new document get the same call: no light effort and no model hint', async () => {
    const shapes: { tools: string[]; modelHint?: string; effort?: string }[] = []
    const { engine } = lead(job => { shapes.push({ tools: job.tools.map(tool => tool.name), ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}) }); return '고쳤어요.' })
    const asks = ['방금 만든 모임 PPT 2번 슬라이드 문구 더 짧게 다듬어줘', 'fixtures/plants.xlsx에 10월 행 추가해줘', '가을 바자회 안내 PPT 3장 새로 만들어줘', '바자회 회의록으로 워드 보고서 만들어줘']
    for (const [at, ask] of asks.entries()) await answer(await worldIn(`w${at}`, engine), ask, { tools: tools() })
    expect(shapes).toHaveLength(asks.length)
    for (const shape of shapes) expect(shape).toEqual({ tools: [...tools().map(tool => tool.name), 'escalate'] })
  })
})

describe('a plain "기억해" and its correction are the model\'s keep_in_mind calls (M1, M2, M3)', () => {
  it('M1 → M2 → M3 against the real memory: the model\'s save, the model\'s correction, what a new thread reads', async () => {
    const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
    await mkdir(paths.notes, { recursive: true })
    const keep = learningTools(paths, 'bot-1', () => '').find(tool => tool.name === 'keep_in_mind')!
    const kept = async () => (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)
    await keep.run({ facts: ['우리 팀 막내는 한도윤이다'] }, { task: '우리 팀 막내 한도윤이야, 외워둬' })
    expect(await kept()).toEqual(['우리 팀 막내는 한도윤이다'])
    await keep.run({ facts: ['우리 팀 막내는 한도현이다'], replaces: ['우리 팀 막내는 한도윤이다'], scope: 'everyone' }, { task: '한도윤 아니고 한도현이야' })
    expect(await kept()).toEqual(['우리 팀 막내는 한도현이다'])
    const note = profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).join('\n')
    expect(note).toContain('한도현')
    expect(note).not.toContain('한도윤')
  })
})

describe('an offer is the next step, never the same content in another shape (H4)', () => {
  const ask = 'fixtures/bazaar-notes.md 회의록에서 할 일만 뽑아줘'
  const draft = '한서연: 온보딩 화면 시안 확정 — 11/20까지\n오태민: 결제 모듈 교체 일정 수립 — 11/24까지\n윤가은: 베타 테스터 모집 공지 발송 — 11/27까지'
  let turns = 0
  async function turn(draft: string, history: { role: string; text: string }[] = []) {
    const { engine, jobs } = lead(() => draft)
    const world = { ...await worldIn(`t${turns++}`, engine), history: [...history] }
    const { result } = await answer(world, ask, { tools: [] })
    return { posted: result!.answer, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  }
  it('the offer is the model\'s line, asked for by the voice\'s rule; the host adds none and no table or file', async () => {
    const offer = '원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.'
    const { posted, told } = await turn(draft)
    expect(posted).toBe(draft)
    expect(told).toContain('ends with exactly ONE short offer line')
    expect([...offer].length).toBeLessThanOrEqual(60)
    const own = `${draft}\n\n${offer}`
    expect((await turn(own)).posted).toBe(own)
    expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
    expect(posted).not.toMatch(/표로 묶어|표로도 정리|워드 파일로도|in a table|Word file/)
  })
  it('dated lines, bare figures and a thread that already had an offer are all posted as written; the once-a-thread rule and the earlier reply are the model\'s to read', async () => {
    for (const draft of ['- 시안 확정: 11월 20일\n- 공지 발송: 11월 27일', '- 38%\n- 12명']) expect((await turn(draft)).posted).toBe(draft)
    const earlier = '정리했어요.\n\n원하시면 워드 파일로도 만들어 드릴게요.'
    const { posted, told } = await turn(draft, [{ role: 'user', text: '바자회 회의록 정리해줘' }, { role: 'assistant', text: earlier }])
    expect(posted).toBe(draft)
    expect(told).toContain('document turns in a row carry at most one offer between them')
    expect(told).toContain('원하시면 워드 파일로도 만들어 드릴게요.')
  })
})

describe('first lines across a document thread (D5, F1)', () => {
  it('the host\'s one line does not turn with the thread, and the voice is told only the last two lines', () => {
    const said = ['표 머리부터 잡을게요.', '열 이름부터 바꿀게요.', '합계 칸부터 채울게요.']
    const prompt = quickPrompt('그 표에 평균 열도 넣어줘', true, said)
    expect(prompt).toContain('"열 이름부터 바꿀게요.", "합계 칸부터 채울게요."')
    expect(prompt).not.toContain('표 머리부터 잡을게요.')
    expect(readFileSync(new URL('../src/main/first-line.ts', import.meta.url), 'utf8')).toContain("SAFETY_LINE = { ko: '바로 확인해 볼게요.', en: 'Checking now.' }")
  })
  it('the voice sees the last two lines with other ways to end, the same prompt whatever they end in', () => {
    const said = ['회의록 내용 정리할게요.', '장표 흐름 구성할게요.']
    const prompt = quickPrompt('3번 슬라이드 본문 고쳐줘', true, said)
    expect(prompt).toContain('Your first sentences earlier in this conversation: "회의록 내용 정리할게요.", "장표 흐름 구성할게요."')
    expect(prompt).toContain('"금방 돼요."')
    expect(quickPrompt('3번 슬라이드 본문 고쳐줘', true, ['회의록 내용 정리할게요.', '장표 흐름 짜볼게요.'])).toBe(prompt.replace('장표 흐름 구성할게요.', '장표 흐름 짜볼게요.'))
  })
})

describe('a deck carries its Korean text unchanged, in a face that has Korean (D2-D4)', () => {
  it('stores the words as given and names a Korean-capable face for them, whatever the theme', async () => {
    const lines = ['매출: 수치 입력', '전년 대비 성장률: 수치 입력', '핵심 전략 과제: 수치 입력']
    for (const theme of [HOUSE_THEME, resolveTheme({ field: '1F3B5B', accent: 'C0603B', fonts: { title: 'Georgia', body: 'Segoe UI' } })!]) {
      const built = await buildDeck({ theme, slides: [{ title: '3분기 실적 보고', subtitle: '다음 주 팀 회의용' }, { title: '3분기 핵심 지표', bullets: lines, table: { rows: [['구분', '7월'], ['매출', '수치 입력']] } }, { title: 'Summary', bullets: ['Revenue up'] }] })
      const zip = await JSZip.loadAsync(built.data), xml = await zip.file('ppt/slides/slide2.xml')!.async('string')
      for (const line of [...lines, '3분기 핵심 지표', '구분', '수치 입력']) expect(xml, line).toContain(`<a:t>${line}</a:t>`)
      const korean = xml.split('<a:r>').slice(1).filter(run => /<a:t>[^<]*[가-힣]/.test(run))
      expect(korean.length).toBeGreaterThanOrEqual(lines.length + 3)
      for (const run of korean) expect(run).toContain('<a:ea typeface="Malgun Gothic"')
      expect(await zip.file('ppt/slides/slide3.xml')!.async('string')).toContain(`<a:latin typeface="${theme.fonts.title}"`)
    }
  })
})
