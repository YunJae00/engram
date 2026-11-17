import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { vaultPaths } from '../../../packages/core/src/vault.js'

// c11c (grokbar stack10 D3/D5): a save chose its file by name. A same-turn fix of a new deck forked to "(2)", and a later title edit landed on
// the stale plain-name draft. Every case here uses wordings and files that are not the harness's.
vi.mock('electron', () => ({ app: { getPath: () => '' }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, nativeImage: {} }))
vi.mock('../src/main/office-host.js', () => ({ officeApps: () => ({ word: true, powerpoint: true, excel: true, outlook: true }), officeSupported: () => true, officeRequest: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => {} }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: vi.fn() }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn(), officeWorkPreview: () => () => {} }))
vi.mock('../src/main/application-work.js', () => ({ applicationWork: () => ({ signal: undefined, show: vi.fn() }), clearApplicationWork: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { mistypedWords, officeAgentTools } from '../src/main/office-agent.js'
import { artifactDirectory, cometFileTools, placeInTask, saveOutput, taskOutputs, twinsFile } from '../src/main/file-work.js'
import { fixSlideTitle } from '../src/main/desk-lane.js'
import { deliverOutputs } from '../src/main/native-tools.js'
import { outputLinks } from '../../../packages/core/src/agent-session-result.js'

const JSZip = createRequire(resolve('packages/core/package.json'))('jszip') as typeof import('../../../packages/core/node_modules/jszip')
const THEME = { field: '#1F2937', accent: '#7C3AED', fonts: { title: 'Pretendard', body: 'Pretendard' } }
const SLIDES = [{ title: '영업 전략 발표', subtitle: '하반기' }, { title: '시장 현황', bullets: ['점유율: 수치 입력'] }, { title: '실행 계획', bullets: ['1월 착수', '3월 점검'] }]

let root: string, task: string
const paths = () => vaultPaths(root)
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/c11c-files-'))
  task = join(root, 'workspace', 'tasks', 'bot-sales')
  await mkdir(task, { recursive: true })
  await mkdir(join(root, 'private'))
  task = await realpath(task)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

// One turn's tools, the way ipc.ts makes them: the office builders and the file tools share the turn id and the set of what it saved.
const turnTools = (turn: string, attached: string[] = [], personal = '') => {
  const made = new Set<string>()
  return [...officeAgentTools('bot-sales', taskOutputs(paths(), async () => task, made, turn), undefined, personal), ...cometFileTools(paths(), 'bot-sales', attached, [task], { turn, made })]
}
const use = async (tools: ReturnType<typeof turnTools>, name: string, args: Record<string, unknown>) => JSON.parse(await tools.find(tool => tool.name === name)!.run(args, { task: 'x' })) as Record<string, unknown> & { path: string; taskPath: string; artifact: string; sha256: string }
const files = async (ext: string) => (await readdir(task)).filter(file => file.endsWith(ext)).sort()
const saved = async (ext: string) => (await readdir(artifactDirectory(paths())).catch(() => [] as string[])).filter(file => file.endsWith(ext))
const xmlOf = async (path: string, part: string) => (await JSZip.loadAsync(await readFile(path))).file(part)!.async('string')
const titleShape = (xml: string) => (xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? []).find(shape => /<p:ph\b[^>]*type="title"/.test(shape)) ?? ''

describe('an edit is saved to the file it read', () => {
  it('a deck built, fixed in the same turn, then retitled in a later turn stays one file with its title in the title placeholder', async () => {
    const t1 = turnTools('t1')
    const built = await use(t1, 'ppt_build', { slides: SLIDES, saveAs: '영업 전략 발표.pptx', theme: THEME })
    // Every slide title is a real title placeholder.
    for (const slide of [1, 2, 3]) expect(titleShape(await xmlOf(built.taskPath, `ppt/slides/slide${slide}.xml`))).toContain(`<a:t>${SLIDES[slide - 1]!.title}</a:t>`)
    // The same turn fixes a word on its own new deck, through the saved output it was handed.
    const outline = await use(t1, 'file_read_package', { path: built.path, outline: true })
    const fixed = await use(t1, 'file_edit_package', { sourcePath: built.path, expectedSha256: outline.sha256, name: '영업 전략 발표.pptx', edits: [{ slide: 3, text: '3월 점검', with: '3월 중간 점검' }] })
    expect(fixed.taskPath).toBe(built.taskPath)
    expect(await files('.pptx')).toEqual(['영업 전략 발표.pptx'])
    expect(await saved('.pptx')).toEqual([fixed.artifact])
    // A later turn changes slide 2's title on the delivered deck (the host's own retitle, as ipc.ts runs it).
    const t2 = turnTools('t2', [fixed.path])
    const done = (await fixSlideTitle({ slide: 2, title: '경쟁 구도' }, { name: '영업 전략 발표.pptx', path: fixed.path }, t2, { task: 'x' }))!
    const receipt = JSON.parse(done.steps[1]!.observation) as { taskPath: string; artifact: string }
    expect(receipt.taskPath).toBe(built.taskPath)
    expect(await files('.pptx')).toEqual(['영업 전략 발표.pptx'])
    expect(await saved('.pptx')).toEqual([receipt.artifact])
    const slide2 = await xmlOf(built.taskPath, 'ppt/slides/slide2.xml')
    expect(titleShape(slide2)).toContain('<a:t>경쟁 구도</a:t>')
    expect(slide2).not.toContain('시장 현황')
    expect(await xmlOf(built.taskPath, 'ppt/slides/slide3.xml')).toContain('3월 중간 점검')
  })

  it('of two same-name decks, the edit lands on the delivered one and the other is untouched', async () => {
    // An older record (before c11c): a draft at the plain name and the delivered fix forked to "(2)".
    const t1 = turnTools('t1')
    const draft = await use(t1, 'ppt_build', { slides: SLIDES, saveAs: '분기 리뷰.pptx', theme: THEME })
    const record = twinsFile(paths(), task), draftBytes = await readFile(draft.taskPath)
    const otherSlides = SLIDES.map(slide => ({ ...slide, title: `${slide.title} 개정` }))
    const deliveredBytes = await readFile((await use(turnTools('t0'), 'ppt_build', { slides: otherSlides, saveAs: '임시.pptx', theme: THEME })).path)
    const delivered = await saveOutput(artifactDirectory(paths()), '분기 리뷰.pptx', deliveredBytes)
    const forked = await placeInTask(task, '분기 리뷰.pptx', deliveredBytes, record, { source: `file_edit_package\0${join(root, 'elsewhere.pptx')}`, turn: 't1', artifact: delivered.artifact, outputs: artifactDirectory(paths()) })
    expect(basename(forked)).toBe('분기 리뷰 (2).pptx')
    // A later turn retitles the deck the thread delivered.
    const t2 = turnTools('t2', [delivered.path])
    const done = (await fixSlideTitle({ slide: 1, title: '연간 회고' }, { name: '분기 리뷰.pptx', path: delivered.path }, t2, { task: 'x' }))!
    const receipt = JSON.parse(done.steps[1]!.observation) as { taskPath: string; artifact: string }
    expect(receipt.taskPath).toBe(forked)
    expect(titleShape(await xmlOf(forked, 'ppt/slides/slide1.xml'))).toContain('<a:t>연간 회고</a:t>')
    expect((await readFile(draft.taskPath)).equals(draftBytes)).toBe(true)
    // The delivered output it replaced is gone; the untouched draft's output stays; no third deck.
    const decks = await saved('분기 리뷰.pptx')
    expect(decks.sort()).toEqual([draft.artifact, receipt.artifact].sort())
    expect(await files('분기 리뷰.pptx').then(() => readdir(task))).toEqual(expect.arrayContaining(['분기 리뷰.pptx', '분기 리뷰 (2).pptx']))
    expect((await readdir(task)).filter(file => file.startsWith('분기 리뷰'))).toHaveLength(2)
  })

  it('a workbook and a document are edited by identity too; an edit saved under another name is a new file', async () => {
    const t1 = turnTools('t1')
    const book = await use(t1, 'file_create_workbook', { name: '예산안.xlsx', sheet: '초안', rows: [['항목', '금액'], ['인건비', 100]] })
    const t2 = turnTools('t2', [book.path])
    const wb = await use(t2, 'file_read_package', { path: book.path, part: 'xl/workbook.xml' })
    const renamed = await use(t2, 'file_edit_package', { sourcePath: book.path, expectedSha256: wb.sha256, name: '예산안.xlsx', edits: [{ part: 'xl/workbook.xml', expectedSha256: wb.partSha256, before: 'name="초안"', after: 'name="확정"' }] })
    expect(renamed.taskPath).toBe(book.taskPath)
    expect(await files('.xlsx')).toEqual(['예산안.xlsx'])
    expect(await saved('.xlsx')).toEqual([renamed.artifact])
    expect(await xmlOf(book.taskPath, 'xl/workbook.xml')).toContain('name="확정"')
    // Saved as another name: a new file beside it, the original untouched.
    const t3 = turnTools('t3', [renamed.path])
    const again = await use(t3, 'file_read_package', { path: renamed.path, part: 'xl/workbook.xml' })
    const copy = await use(t3, 'file_edit_package', { sourcePath: renamed.path, expectedSha256: again.sha256, name: '예산안 사본.xlsx', edits: [{ part: 'xl/workbook.xml', expectedSha256: again.partSha256, before: 'name="확정"', after: 'name="검토"' }] })
    expect(basename(copy.taskPath)).toBe('예산안 사본.xlsx')
    expect(await xmlOf(book.taskPath, 'xl/workbook.xml')).toContain('name="확정"')

    const doc = await use(t1, 'word_write', { blocks: [{ kind: 'title', text: '주간 보고' }, { kind: 'heading', text: '이번 주 진행' }, { kind: 'paragraph', text: '계약 두 건 마무리' }], saveAs: '주간 보고.docx', theme: THEME })
    const t4 = turnTools('t4', [doc.path])
    const body = await use(t4, 'file_read_package', { path: doc.taskPath, part: 'word/document.xml' })
    const heading = await use(t4, 'file_edit_package', { sourcePath: doc.taskPath, expectedSha256: body.sha256, name: '주간 보고.docx', edits: [{ part: 'word/document.xml', expectedSha256: body.partSha256, before: '이번 주 진행', after: '이번 주 성과' }] })
    expect(heading.taskPath).toBe(doc.taskPath)
    expect(await files('.docx')).toEqual(['주간 보고.docx'])
    expect(await saved('.docx')).toEqual([heading.artifact])
    expect(await xmlOf(doc.taskPath, 'word/document.xml')).toContain('이번 주 성과')
  })

  // c11c r3: an edit saved under another name is a new file, so the file it read is still handed over beside it (a card for each).
  it('hands over both files when a same-turn edit is saved under another name; one card when it is saved onto the file', async () => {
    const t1 = turnTools('t1')
    const run = async (tools: ReturnType<typeof turnTools>, name: string, args: Record<string, unknown>) => { const observation = await tools.find(tool => tool.name === name)!.run(args, { task: 'x' }); return { step: { tool: name, args, observation }, receipt: JSON.parse(observation) as { path: string; taskPath: string; artifact: string; sha256: string; markdownLink: string } } }
    const built = await run(t1, 'ppt_build', { slides: SLIDES, saveAs: '고객 설문 결과.pptx', theme: THEME })
    const outline = await run(t1, 'file_read_package', { path: built.receipt.path, outline: true })
    const copy = await run(t1, 'file_edit_package', { sourcePath: built.receipt.path, expectedSha256: outline.receipt.sha256, name: '고객 설문 결과 요약본.pptx', edits: [{ slide: 2, with: '응답 요약' }] })
    expect(copy.receipt.taskPath).not.toBe(built.receipt.taskPath)
    expect(await files('.pptx')).toEqual(['고객 설문 결과 요약본.pptx', '고객 설문 결과.pptx'])
    const steps = [built.step, outline.step, copy.step]
    const answer = outputLinks(steps, `요약본도 만들었어요. ${copy.receipt.markdownLink}`, task)
    const result = { answer, steps }
    await deliverOutputs(paths(), task, result, 0, 'x')
    expect(result.answer).toContain(copy.receipt.markdownLink)
    expect(result.answer.match(/engram-artifact:/g)).toHaveLength(2)
    expect(result.answer).toContain(built.receipt.markdownLink)
    // A workbook is handed over by the host: on the answer as the model wrote it, the original goes over beside its differently named copy.
    const book = await run(t1, 'file_create_workbook', { name: '동호회 회비.xlsx', sheet: '3월', rows: [['이름', '회비'], ['가람', 20000]] })
    const wb = await run(t1, 'file_read_package', { path: book.receipt.path, part: 'xl/workbook.xml' })
    const wbPart = (JSON.parse(wb.step.observation) as { partSha256: string }).partSha256
    const april = await run(t1, 'file_edit_package', { sourcePath: book.receipt.path, expectedSha256: wb.receipt.sha256, name: '동호회 회비 4월.xlsx', edits: [{ part: 'xl/workbook.xml', expectedSha256: wbPart, before: 'name="3월"', after: 'name="4월"' }] })
    expect(april.receipt.taskPath).not.toBe(book.receipt.taskPath)
    const raw = { answer: `4월 것도 만들었어요. ${april.receipt.markdownLink}`, steps: [book.step, wb.step, april.step] }
    await deliverOutputs(paths(), task, raw, 0, 'x')
    expect(raw.answer.match(/engram-artifact:/g)).toHaveLength(2)
    expect(raw.answer).toContain(april.receipt.markdownLink)
    expect(raw.answer).toContain(encodeURIComponent(book.receipt.artifact))

    // The same edit under the file's own name is that file, now edited: one card, the edit's.
    const t2 = turnTools('t2')
    const deck = await run(t2, 'ppt_build', { slides: SLIDES, saveAs: '팀 워크숍 안내.pptx', theme: THEME })
    const seen = await run(t2, 'file_read_package', { path: deck.receipt.path, outline: true })
    const fix = await run(t2, 'file_edit_package', { sourcePath: deck.receipt.path, expectedSha256: seen.receipt.sha256, name: '팀 워크숍 안내.pptx', edits: [{ slide: 2, with: '준비물' }] })
    expect(fix.receipt.taskPath).toBe(deck.receipt.taskPath)
    const one = { answer: outputLinks([deck.step, seen.step, fix.step], `고쳤어요. ${fix.receipt.markdownLink}`, task), steps: [deck.step, seen.step, fix.step] }
    await deliverOutputs(paths(), task, one, 0, 'x')
    expect(one.answer).toBe(`고쳤어요. ${fix.receipt.markdownLink}`)
  })

  it('a new build never overwrites a same-name file an earlier turn made', async () => {
    const first = await use(turnTools('t1'), 'ppt_build', { slides: SLIDES, saveAs: '영업 전략 발표.pptx', theme: THEME })
    const before = await readFile(first.taskPath)
    const second = await use(turnTools('t2'), 'ppt_build', { slides: SLIDES.slice(0, 2), saveAs: '영업 전략 발표.pptx', theme: THEME })
    expect(second.taskPath).not.toBe(first.taskPath)
    expect((await readFile(first.taskPath)).equals(before)).toBe(true)
    expect(await saved('.pptx')).toHaveLength(2)
  })
  // stack-11 (review of placeInTask/composeOffice): a name with capital letters is still seen as taken (freeName asks in lower case).
  it('a new build never overwrites an earlier turn\'s file whose name has capital letters', async () => {
    const first = await use(turnTools('t1'), 'ppt_build', { slides: SLIDES, saveAs: 'Q4 Sales Kickoff.pptx', theme: THEME })
    const before = await readFile(first.taskPath)
    const second = await use(turnTools('t2'), 'ppt_build', { slides: SLIDES.slice(0, 2), saveAs: 'Q4 Sales Kickoff.pptx', theme: THEME })
    expect(second.taskPath).not.toBe(first.taskPath)
    expect((await readFile(first.taskPath)).equals(before)).toBe(true)
    expect(await files('.pptx')).toHaveLength(2)
    // Its own draft made again in one turn is still replaced in place.
    const t3 = turnTools('t3')
    const draft = await use(t3, 'ppt_build', { slides: SLIDES, saveAs: 'Board Update.pptx', theme: THEME })
    const again = await use(t3, 'ppt_build', { slides: SLIDES.slice(0, 2), saveAs: 'Board Update.pptx', theme: THEME })
    expect(again.taskPath).toBe(draft.taskPath)
  })
})

describe('a garbled build is refused before any file exists', () => {
  it('names broken syllables and replacement characters; clean Korean, English and numbers pass', () => {
    expect(mistypedWords([{ where: 'slide 2', text: '매출 전놙0대름 확인' }])).toEqual(['전놙0대름 (slide 2)'])
    expect(mistypedWords([{ where: 'block 1', text: '고객 만족�도 조사' }])).toEqual(['만족�도 (block 1)'])
    expect(mistypedWords([{ where: 'slide 1', text: '분기 매ᅡ출' }])).toEqual(['매ᅡ출 (slide 1)'])
    expect(mistypedWords([{ where: 'slide 4', text: '결과 보고\u0001서' }])).toEqual(['보고\u0001서 (slide 4)'])
    expect(mistypedWords([{ where: 'slide 1', text: '2025년 Q3 매출 1,240만 원, YoY +12% (Revenue up)' }, { where: 'slide 2', text: '담당: 한서연 · 기한 11월 20일' }])).toEqual([])
  })

  it('refuses the build with the exact words and writes nothing; the fixed text builds once', async () => {
    const tools = turnTools('t1')
    const build = tools.find(tool => tool.name === 'ppt_build')!
    const garbled = [{ title: '신제품 출시' }, { title: '일정', bullets: ['4월 베타 �공개', '6월 정식 촐놙시'] }]
    const refusal = await build.run({ slides: garbled, saveAs: '신제품 출시.pptx', theme: THEME }, { task: 'x' }).then(() => '', (error: Error) => error.message)
    expect(refusal).toContain('�공개 (slide 2)')
    expect(refusal).toContain('촐놙시 (slide 2)')
    expect(await readdir(task)).toEqual([])
    expect(await saved('.pptx')).toEqual([])
    const ok = await use(tools, 'ppt_build', { slides: [{ title: '신제품 출시' }, { title: '일정', bullets: ['4월 베타 공개', '6월 정식 출시'] }], saveAs: '신제품 출시.pptx', theme: THEME })
    expect(await files('.pptx')).toEqual(['신제품 출시.pptx'])
    expect(ok.mistyped).toBeUndefined()
    // A document too.
    const word = tools.find(tool => tool.name === 'word_write')!
    await expect(word.run({ blocks: [{ kind: 'title', text: '회의 놙록' }], saveAs: '회의.docx', theme: THEME }, { task: 'x' })).rejects.toThrow('놙록 (block 1)')
    expect(await files('.docx')).toEqual([])
  })

  // c11c r2 (Codex r1): resending the same garbled text used to be taken as meant, so a model repeating its own slip saved it.
  it('refuses the same garbled text however often it is resent; nothing is ever written', async () => {
    const tools = turnTools('t1')
    const build = tools.find(tool => tool.name === 'ppt_build')!, word = tools.find(tool => tool.name === 'word_write')!
    const slides = [{ title: '하반기 채용 계횓' }, { title: '일정', bullets: ['서류 마감 �월 3일'] }]
    for (let round = 0; round < 3; round++) {
      await expect(build.run({ slides, saveAs: '채용.pptx', theme: THEME }, { task: 'x' })).rejects.toThrow('계횓 (slide 1)')
      await expect(word.run({ blocks: [{ kind: 'title', text: '주간 회의 결괉' }], saveAs: '회의.docx', theme: THEME }, { task: 'x' })).rejects.toThrow('결괉 (block 1)')
    }
    expect(await readdir(task)).toEqual([])
    expect(await saved('.pptx')).toEqual([])
  })

  it('builds a rare syllable the person typed themselves (a name) first time; their typing never lets broken marks through', async () => {
    const tools = turnTools('t1', [], '똠양꿍 맛집 소개 자료 만들어줘. 사장님 이름은 김뷁이야')
    const deck = await use(tools, 'ppt_build', { slides: [{ title: '똠양꿍 맛집 소개' }, { title: '사장님', bullets: ['김뷁 대표'] }], saveAs: '맛집.pptx', theme: THEME })
    expect(deck.markdownLink).toContain('맛집.pptx')
    const build = tools.find(tool => tool.name === 'ppt_build')!
    await expect(build.run({ slides: [{ title: '김뷁 대\uFFFD표' }], saveAs: '맛집2.pptx', theme: THEME }, { task: 'x' })).rejects.toThrow('Nothing was built')
    // A rare syllable the person never typed is still the model's slip.
    expect(mistypedWords([{ where: 'slide 1', text: '똠양꿍 놙집' }], '똠양꿍 맛집')).toEqual(['놙집 (slide 1)'])
  })
})
