import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
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
import { officeAgentTools, proofFixes } from '../src/main/office-agent.js'
import { createRequire } from 'node:module'
const JSZip = createRequire(resolve('packages/core/package.json'))('jszip') as typeof import('../../../packages/core/node_modules/jszip')
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

// qa143 p2 r3 #3 said two inputs under one name in a turn were two files (report, report-2). grokbar D3 (stack9) showed what that does: one
// deck rebuilt twice became three cards. The same name in one turn is now that turn's own file made again: one file, one card, the last one.
it('replaces this turn\'s own file when a second input is built under its name, and shows only the last', async () => {
  const { outputLinks } = await import('../../../packages/core/src/agent-session-result.js')
  for (const [name, ext, input] of [['word_write', 'docx', (text: string) => ({ title: 'report', blocks: [{ kind: 'paragraph', text }], theme: THEME })], ['ppt_build', 'pptx', (text: string) => ({ slides: [{ title: text }], saveAs: 'report.pptx', theme: THEME })]] as const) {
    const tool = officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task, undefined, `turn-${ext}`)).find(t => t.name === name)!
    const run = async (text: string) => { const args = input(text), observation = await tool.run(args, { task: '보고서' }); return { step: { tool: name, args, observation }, receipt: JSON.parse(observation) as { markdownLink: string; artifact: string; taskPath: string; path: string } } }
    const sales = await run('sales'), costs = await run('costs')
    expect(sales.receipt.markdownLink).toMatch(new RegExp(`^\\[report\\.${ext}\\]\\(engram-artifact:`))
    expect(costs.receipt.markdownLink).toMatch(new RegExp(`^\\[report\\.${ext}\\]\\(engram-artifact:`))
    expect(costs.receipt.taskPath).toBe(sales.receipt.taskPath)
    expect((await readdir(task)).filter(file => file.endsWith(`.${ext}`))).toEqual([`report.${ext}`])
    // The draft's saved output is gone; the last one holds the task file's bytes.
    await expect(stat(sales.receipt.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(costs.receipt.path)).equals(await readFile(costs.receipt.taskPath))).toBe(true)
    const steps = [sales.step, costs.step] as unknown as Parameters<typeof outputLinks>[0]
    for (const quoted of [sales, costs]) {
      const answer = outputLinks(steps, `보고서: ${quoted.receipt.markdownLink}`)
      expect(answer.split(costs.receipt.markdownLink).length - 1).toBe(1)
      expect(answer).not.toContain(sales.receipt.artifact)
    }
    expect(outputLinks(steps, '다 만들었어요.').match(/engram-artifact:/g)).toHaveLength(1)
    // The same input again after another replaced it is built again, not handed back as the draft that is gone.
    const again = await run('sales')
    expect((await readFile(again.receipt.path)).equals(await readFile(again.receipt.taskPath))).toBe(true)
  }
})

// A turn that only names the file an earlier turn made does not touch it (c10c review r1: the brief's "a name taken by an earlier turn still
// gets -2"): a new turn's build under that name is saved as "-2", the earlier task file keeps its bytes, and the earlier saved output stays.
// Built twice in that later turn, the "-2" file is that turn's own draft, replaced in place.
it('keeps the file an earlier turn made when a later turn builds under its name', async () => {
  const first = JSON.parse(await officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task, undefined, 'turn-1')).find(t => t.name === 'ppt_build')!.run({ slides: [{ title: '3분기 실적' }], saveAs: '3분기 실적 보고.pptx', theme: THEME }, { task: 'PPT' }))
  const before = await readFile(first.taskPath)
  const tool = officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task, undefined, 'turn-2')).find(t => t.name === 'ppt_build')!
  const later = JSON.parse(await tool.run({ slides: [{ title: '4분기 계획' }], saveAs: '3분기 실적 보고.pptx', theme: THEME }, { task: 'PPT' }))
  expect(later.artifact).not.toBe(first.artifact)
  expect(later.markdownLink).toMatch(/^\[3분기 실적 보고-2\.pptx\]/)
  expect(later.verification).toContain('Saved as 3분기 실적 보고-2.pptx')
  expect(basename(later.taskPath)).toBe('3분기 실적 보고-2.pptx')
  expect((await readFile(first.taskPath)).equals(before)).toBe(true)
  expect((await readFile(first.path)).subarray(0, 2).toString()).toBe('PK')
  const again = JSON.parse(await tool.run({ slides: [{ title: '4분기 계획 수정' }], saveAs: '3분기 실적 보고.pptx', theme: THEME }, { task: 'PPT' }))
  expect(again.taskPath).toBe(later.taskPath)
  expect((await readdir(task)).filter(file => file.endsWith('.pptx')).sort()).toEqual(['3분기 실적 보고-2.pptx', '3분기 실적 보고.pptx'])
  expect((await readFile(first.taskPath)).equals(before)).toBe(true)
})

// grokbar D3 (stack9): the first deck the model built read "수시 입력", "대믱", "변류̈은", "거실론" (the stored 3분기 실적 보고.pptx); with only
// "saved" in the receipt it read the deck back, built it again ("수지", "결맠") and once more. The receipt now lists the slides, says not to
// read it back; a garbled build is refused before it is saved, naming the words with their slide (c11c).
it('says a built deck is done and lists its slides; refuses the garbled stored stack-9 deck before saving it', async () => {
  const stored = [
    { title: '3분기 실적 보고', subtitle: '팀 회의 자리' },
    { title: '3분기 요약', bullets: ['매출: 수시 입력 (전분기 대믱 수시 입력)', '영업이익: 수시 입력', '목표 대매출: 수시 입력', '전사적인 추이: 수시 입력'] },
    { title: '주요 지표', table: { rows: [['지표', '목표', '실적', '달성률'], ['매출', '수시 입력', '수시 입력', '수시 입력']] } },
    { title: '변류\u0308은 달성 요인과 고전 요인', bullets: ['달성 요인: 내역 입력', '고전 요인: 내역 입력', '거실론: 내역 입력'] },
    { title: '4분기 개선 계획', bullets: ['다음 분기 목표: 수시 입력'] },
  ]
  // c11c: the garbled build is refused before any file exists, naming the words, so the fix is one rebuild (not a saved file and edit rounds).
  const build = tools().find(t => t.name === 'ppt_build')!
  const refusal = await build.run({ slides: stored, saveAs: '3분기 실적 보고.pptx', theme: THEME }, { task: 'PPT 5장' }).then(() => '', (error: Error) => error.message)
  expect(refusal).toContain('대믱 (slide 2)')
  expect(refusal).toContain('변류\u0308은 (slide 4)')
  expect(refusal).toContain('ppt_build again')
  expect(await readdir(task)).toEqual([])
  const fixed = stored.map(slide => JSON.parse(JSON.stringify(slide).replaceAll('대믱', '대비').replaceAll('변류\u0308은', '분류')) as typeof slide)
  const receipt = JSON.parse(await build.run({ slides: fixed, saveAs: '3분기 실적 보고.pptx', theme: THEME }, { task: 'PPT 5장' }))
  expect(receipt.verification).toContain('do not read it back or build it again')
  expect(receipt.verification).toContain('1. 3분기 실적 보고 / 2. 3분기 요약 / 3. 주요 지표')
  expect(receipt.titles).toHaveLength(5)
  expect(receipt.mistyped).toBeUndefined()
  expect(await readdir(task)).toEqual(['3분기 실적 보고.pptx'])
  const clean = JSON.parse(await tools().find(t => t.name === 'ppt_build')!.run({ slides: [{ title: '3분기 실적 보고' }, { title: '요약', bullets: ['매출: 수치 입력 (전분기 대비 수치 입력)', '결론: 내역 입력'] }], theme: THEME }, { task: 'PPT' }))
  expect(clean.mistyped).toBeUndefined()
})

// c10c r3 (D3): garble made of syllables people do type ("거실론", "수시 입력" in stack 9) passed the syllable check. The quick voice now
// reads the text before the build and the host puts the meant words in, so the one file built is clean. Words below are not the harness's.
it('builds a deck with the garbled words the proofreader names already fixed, in one file', async () => {
  const asked: string[] = []
  const proofread = async (prompt: string): Promise<string> => { asked.push(prompt); return '회으록 => 회의록\n- "담당쟈" → 담당자\n없는말 => 아무말\n2023년 => 2024년\n예산 => 이번 분기 전체 예산 계획' }
  const tool = officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task), proofread).find(t => t.name === 'ppt_build')!
  const deck = [{ title: '주간 회으록' }, { title: '할 일', bullets: ['담당쟈: 민수, 2023년 예산 확인'] }]
  const receipt = JSON.parse(await tool.run({ slides: deck, saveAs: '주간 회의.pptx', theme: THEME }, { task: '회의 PPT' }))
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('주간 회으록')
  expect(asked[0]).toContain('담당쟈: 민수, 2023년 예산 확인')
  expect(receipt.titles).toEqual(['주간 회의록', '할 일'])
  const xml = (await Promise.all(Object.values((await JSZip.loadAsync(await readFile(receipt.path))).files).filter(file => /slide\d+\.xml$/.test(file.name)).map(file => file.async('string')))).join('')
  expect(xml).toContain('담당자: 민수, 2023년 예산 확인')
  expect(xml).not.toContain('회으록')
  expect((await readdir(task)).filter(file => file.endsWith('.pptx'))).toEqual(['주간 회의.pptx'])
})

it('builds the deck as written when the proofreader fails or says nothing is garbled', async () => {
  for (const proofread of [async () => { throw new Error('late') }, async () => 'NONE']) {
    const receipt = JSON.parse(await officeAgentTools('bot-one', taskOutputs(vaultPaths(root), async () => task), proofread).find(t => t.name === 'ppt_build')!.run({ slides: [{ title: '분기 계획' }], theme: THEME }, { task: 'PPT' }))
    expect(receipt.titles).toEqual(['분기 계획'])
  }
})

it('keeps only safe fixes from a proofread: a word in the text, Korean on both sides, the same digits, a close length', () => {
  const texts = ['출시일: 3월 5일 확정', '마케팅 예산 검토즁']
  expect(proofFixes('검토즁 => 검토 중\n3월 5일 => 4월 5일\n없는말 => 아무말\nmarketing => 마케팅\n예산 => 올해 전체 마케팅 예산 총액\n아무 설명 문장', texts)).toEqual([['검토즁', '검토 중']])
  expect(proofFixes('NONE', texts)).toEqual([])
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
