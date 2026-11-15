import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { vaultPaths } from '../../../packages/core/src/vault.js'

// QA 0.8.142 B5/B11: Word and PowerPoint output went to the person's real
// ~/Documents/Engram whatever the workspace, and generation opened Word or
// PowerPoint on the real screen (also in hidden mode). A composed document is
// built headlessly, handed in with the task's outputs and linked in the chat.
const fake = vi.hoisted(() => ({ home: '', request: vi.fn(), openPath: vi.fn(), bind: vi.fn(), preview: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fake.home }, shell: { openPath: fake.openPath }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, nativeImage: {} }))
vi.mock('../src/main/office-host.js', () => ({ officeApps: () => ({ word: true, powerpoint: true, excel: true, outlook: true }), officeSupported: () => true, officeRequest: fake.request }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => {} }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: fake.bind }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn(), officeWorkPreview: () => fake.preview }))
vi.mock('../src/main/application-work.js', () => ({ applicationWork: () => ({ signal: undefined, show: vi.fn() }), clearApplicationWork: vi.fn() }))
import { officeAgentTools } from '../src/main/office-agent.js'
import { taskOutputs } from '../src/main/file-work.js'

const THEME = { field: '#1F2937', accent: '#7C3AED', fonts: { title: 'Pretendard', body: 'Pretendard' } }
let root: string, task: string
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/office-compose-'))
  fake.home = join(root, 'home')
  task = join(root, 'workspace', 'tasks', 'bot-one')
  await mkdir(task, { recursive: true })
  for (const spy of [fake.request, fake.openPath, fake.bind, fake.preview]) spy.mockReset()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const tools = () => officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task))
const slides = [{ title: '4분기 출시 계획' }, { title: '일정', bullets: ['12월 3일 출시', '랜딩 페이지 금요일 공유'] }]

it('builds a deck headlessly into the task outputs, linked in the chat, without opening PowerPoint', async () => {
  const result = JSON.parse(await tools().find(t => t.name === 'ppt_build')!.run({ slides, theme: THEME, saveAs: '/Users/someone/Documents/Engram/plan.pptx' }, { task: '슬라이드 만들어줘' }))
  expect(result.markdownLink).toMatch(/^\[plan\.pptx\]\(engram-artifact:/)
  expect(result.slides).toBe(2)
  expect(result.path.startsWith(vaultPaths(root).workspace) || result.path.includes('.engram')).toBe(true)
  expect(result.taskPath).toBe(join(await import('node:fs/promises').then(fs => fs.realpath(task)), 'plan.pptx'))
  expect((await readFile(result.path)).subarray(0, 2).toString()).toBe('PK')
  expect(fake.request).not.toHaveBeenCalled()
  expect(fake.openPath).not.toHaveBeenCalled()
  expect(fake.bind).not.toHaveBeenCalled()
  // Nothing lands in the person's own folders.
  await expect(stat(join(fake.home, 'Engram'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat('/Users/someone/Documents/Engram/plan.pptx')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('writes a Word document the same way, without opening Word', async () => {
  const tool = tools().find(t => t.name === 'word_write')!
  const args = { title: '회의록', blocks: [{ kind: 'title', text: '제품 출시 회의록' }, { kind: 'bullets', items: ['출시일 12월 3일'] }], theme: THEME }
  const first = JSON.parse(await tool.run(args, { task: '회의록 문서로 만들어줘' }))
  expect(first.markdownLink).toMatch(/^\[회의록\.docx\]\(engram-artifact:/)
  expect(first.blocks).toBe(2)
  expect((await readdir(task)).filter(name => name.endsWith('.docx'))).toEqual(['회의록.docx'])
  expect(fake.request).not.toHaveBeenCalled()
  expect(fake.openPath).not.toHaveBeenCalled()
  await expect(stat(join(fake.home, 'Engram'))).rejects.toMatchObject({ code: 'ENOENT' })
})

// qa143 p2 r3 #3: two different inputs under one name are two files, known by name; the same input built again is the file already handed in.
// The answer's link to one of them does not hide the other.
it('hands in a second input under one name as report-2, and keeps both when the answer links one', async () => {
  const { outputLinks } = await import('../../../packages/core/src/agent-session-result.js')
  for (const [name, ext, input] of [['word_write', 'docx', (text: string) => ({ title: 'report', blocks: [{ kind: 'paragraph', text }], theme: THEME })], ['ppt_build', 'pptx', (text: string) => ({ slides: [{ title: text }], saveAs: 'report.pptx', theme: THEME })]] as const) {
    const tool = tools().find(t => t.name === name)!
    const run = async (text: string) => { const args = input(text), observation = await tool.run(args, { task: '보고서' }); return { step: { tool: name, args, observation }, receipt: JSON.parse(observation) as { markdownLink: string; artifact: string; taskPath: string } } }
    const sales = await run('sales'), costs = await run('costs'), again = await run('sales')
    expect(sales.receipt.markdownLink).toMatch(new RegExp(`^\\[report\\.${ext}\\]\\(engram-artifact:`))
    expect(costs.receipt.markdownLink).toMatch(new RegExp(`^\\[report-2\\.${ext}\\]\\(engram-artifact:`))
    expect(again.receipt.artifact).toBe(sales.receipt.artifact)
    expect((await readdir(task)).filter(file => file.endsWith(`.${ext}`)).sort()).toEqual([`report-2.${ext}`, `report.${ext}`])
    const steps = [sales.step, costs.step, again.step] as unknown as Parameters<typeof outputLinks>[0]
    for (const quoted of [sales, costs]) {
      const answer = outputLinks(steps, `보고서: ${quoted.receipt.markdownLink}`)
      for (const one of [sales, costs]) expect(answer.split(one.receipt.markdownLink).length - 1).toBe(1)
    }
  }
})

it('hands in one file when the same deck is built again', async () => {
  const tool = tools().find(t => t.name === 'ppt_build')!
  const first = JSON.parse(await tool.run({ slides, theme: THEME }, { task: '슬라이드' }))
  const second = JSON.parse(await tool.run({ slides, theme: THEME }, { task: '슬라이드' }))
  expect(second.artifact).toBe(first.artifact)
  expect(second.taskPath).toBe(first.taskPath)
  expect((await readdir(task)).filter(name => name.endsWith('.pptx'))).toHaveLength(1)
})

it('hands in one file when the same deck is built again seconds later (built bytes carry a timestamp)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
    const tool = tools().find(t => t.name === 'ppt_build')!
    const first = JSON.parse(await tool.run({ slides, theme: THEME }, { task: '슬라이드' }))
    vi.setSystemTime(new Date('2026-11-15T12:00:07Z'))
    const second = JSON.parse(await tool.run({ slides, theme: THEME }, { task: '슬라이드' }))
    expect(second.artifact).toBe(first.artifact)
    expect((await readdir(task)).filter(name => name.endsWith('.pptx'))).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

it('refuses to compose where no outputs are kept instead of writing to Documents', async () => {
  const tool = officeAgentTools('standing-watch').find(t => t.name === 'ppt_build')!
  await expect(tool.run({ slides, theme: THEME }, { task: 'Build slides' })).rejects.toThrow('keeps its outputs')
  await expect(stat(join(fake.home, 'Engram'))).rejects.toMatchObject({ code: 'ENOENT' })
})
