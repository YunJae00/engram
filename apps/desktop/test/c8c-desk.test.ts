import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileWorkTools, HOUSE_THEME, loadBotMemory, PERSON_MEMORY, PROFILE_NOTE_ID, profileLines, resolveTheme, runToolSession, type AgentLoopOptions, type Engine, type EngineCwd, type ToolSessionJob, type VaultPaths } from 'core'

const fake = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.directory, isPackaged: false }, shell: { openPath: async () => '' }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
import { DESK_NOTE, deskKind, deskLight, fixSlideTitle, keptFix, plainKeep, slideTitleFix } from '../src/main/desk-lane.js'
import { SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'
import { fallbackLine, firstLinePrompt, saidBefore } from '../src/main/first-line.js'
import { buildDeck } from '../src/main/deck-render.js'
import { learningTools } from '../src/main/learning-wiring.js'

const require = createRequire(resolve('packages/core/package.json'))
const JSZip = require('jszip') as typeof import('../../../packages/core/node_modules/jszip')
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

let root: string
beforeEach(async () => { await mkdir(resolve('tmp'), { recursive: true }); root = await mkdtemp(resolve('tmp/c8c-desk-')); fake.directory = root })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('a slide title by number is changed by the host (D5)', () => {
  it('reads the shape: a slide number, 제목, the new words in quotes, a change word', () => {
    expect(slideTitleFix('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toEqual({ slide: 3, title: '핵심 지표' })
    expect(slideTitleFix('2번 장 제목을 \'일정\'으로 고쳐')).toEqual({ slide: 2, title: '일정' })
    expect(slideTitleFix('그 PPT 4번째 슬라이드의 제목을 “다음 분기 계획”으로 수정해 주세요.')).toEqual({ slide: 4, title: '다음 분기 계획' })
    expect(slideTitleFix('plan.pptx에서 슬라이드 5번 제목 "마무리"로 변경해줘')).toEqual({ slide: 5, title: '마무리', file: 'plan.pptx' })
    expect(slideTitleFix('Change the title of slide 2 to "Key metrics"')).toEqual({ slide: 2, title: 'Key metrics' })
    expect(slideTitleFix('change slide 3\'s title to "Roadmap".')).toEqual({ slide: 3, title: 'Roadmap' })
  })
  it('refuses anything that is not exactly that', () => {
    for (const ask of [
      '방금 만든 PPT 3번 슬라이드 제목 핵심 지표로 바꿔줘',
      '3번 슬라이드 "핵심 지표"로 바꿔줘',
      '3번 슬라이드 본문 "매출: 수치 입력"을 "매출 12억"으로 바꿔줘',
      '3번 슬라이드 제목 아래 문구를 "핵심 지표"로 바꿔줘',
      '3번 슬라이드 제목 "핵심 지표"로 바꾸고 민호한테 메일로 보내줘',
      '3번 슬라이드 제목 "핵심 지표"로 바꾸면 어떨까?',
      '3분기 보고 PPT 2번 슬라이드 제목 "일정"으로 바꿔줘',
      'a.pptx랑 b.pptx 3번 슬라이드 제목 "핵심 지표"로 바꿔줘',
      '제목 "핵심 지표"로 바꿔줘',
    ]) expect(slideTitleFix(ask), ask).toBeUndefined()
  })
  it('routes such an ask as document work even with no deck word in it', () => {
    expect(deskKind('2번 장 제목을 \'일정\'으로 고쳐')).toBe('deck')
    expect(deskKind('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toBe('deck')
  })

  const deck = async () => {
    const built = await buildDeck({ theme: HOUSE_THEME, slides: [{ title: '3분기 실적 보고', subtitle: '다음 주 팀 회의용' }, { title: '요약', bullets: ['매출: 수치 입력', '영업이익: 수치 입력'] }, { title: '주요 지표', bullets: ['전년 대비 성장률: 수치 입력'] }] })
    const path = join(root, built.name)
    await writeFile(path, built.data)
    return { name: built.name, path }
  }
  const slideText = async (path: string, slide: number) => (await (await JSZip.loadAsync(await readFile(path))).file(`ppt/slides/slide${slide}.xml`)!.async('string'))
  const tools = (approveRead: () => Promise<boolean> = async () => true) => fileWorkTools({ directory: join(root, 'outputs'), approveRead: approveRead as never })

  it('edits the deck through the tools\' own read and edit calls and answers in one line', async () => {
    const made = await deck()
    const done = (await fixSlideTitle({ slide: 3, title: '핵심 지표' }, made, tools(), { task: '3번 슬라이드 제목 바꿔줘' }))!
    expect(done.answer).toBe('3번 슬라이드 제목을 "핵심 지표"로 바꿨어요.')
    expect(done.steps.map(step => step.tool)).toEqual(['file_read_package', 'file_edit_package'])
    expect(done.steps[0]!.args).toEqual({ path: made.path, outline: true })
    expect(done.steps[1]!.args).toMatchObject({ sourcePath: made.path, name: made.name, edits: [{ slide: 3, with: '핵심 지표' }] })
    const receipt = JSON.parse(done.steps[1]!.observation) as { path: string; markdownLink: string; changedParts: string[] }
    expect(receipt.changedParts).toEqual(['ppt/slides/slide3.xml'])
    expect(receipt.markdownLink).toContain(made.name)
    const xml = await slideText(receipt.path, 3)
    expect(xml).toContain('<a:t>핵심 지표</a:t>')
    expect(xml).not.toContain('주요 지표')
    expect(xml).toContain('전년 대비 성장률: 수치 입력')
    expect(await readdir(join(root, 'outputs'))).toHaveLength(1)
    expect((await fixSlideTitle({ slide: 2, title: '일정' }, made, tools(), { task: '' }))!.answer).toBe('2번 슬라이드 제목을 "일정"으로 바꿨어요.')
  })
  it('writes nothing and leaves the turn to the model on a slide past the end, a refused read or a missing tool', async () => {
    const made = await deck(), before = await readFile(made.path)
    expect(await fixSlideTitle({ slide: 9, title: '핵심 지표' }, made, tools(), { task: '' })).toBeUndefined()
    expect(await fixSlideTitle({ slide: 3, title: '핵심 지표' }, made, tools(async () => false), { task: '' })).toBeUndefined()
    expect(await fixSlideTitle({ slide: 3, title: '핵심 지표' }, { name: 'gone.pptx', path: join(root, 'gone.pptx') }, tools(), { task: '' })).toBeUndefined()
    expect(await fixSlideTitle({ slide: 3, title: '핵심 지표' }, made, tools().filter(tool => tool.name !== 'file_edit_package'), { task: '' })).toBeUndefined()
    expect(await readdir(join(root, 'outputs')).catch(() => [])).toEqual([])
    expect(await readFile(made.path)).toEqual(before)
  })
  it('is made before the model, only on the one deck of the thread, and logged', () => {
    expect(ipc).toContain("const retitle = kind === 'deck' ? slideTitleFix(request.message) : undefined")
    expect(ipc).toContain('retitle && decks.length === 1 && (!retitle.file || retitle.file === decks[0]!.name) ? await fixSlideTitle(retitle, decks[0]!, everyTool,')
    expect(ipc).toContain("if (retitled) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'slide-fix' })) }")
    expect(ipc).toContain(': retitled ? { ...retitled, fellBack: false } : sorted ? { ...sorted, fellBack: false } : await lookup.run(')
  })
})

describe('which desk turns think briefly (D5, F1)', () => {
  it('a change to a document that exists is light; a new document is not; tidy, keep and a pre-read note are', () => {
    expect(deskLight('deck', '방금 만든 PPT 3번 슬라이드 본문 좀 더 짧게 고쳐줘', { made: true })).toBe(true)
    expect(deskLight('deck', 'fixtures/budget.xlsx에 12월 행 추가해줘', {})).toBe(true)
    expect(deskLight('deck', '그 보고서에서 미결 부분은 빼줘', { made: true })).toBe(true)
    expect(deskLight('deck', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', { made: true })).toBe(false)
    expect(deskLight('deck', '위 회의록으로 워드 보고서 만들어줘', {})).toBe(false)
    expect(deskLight('deck', '차트 추가해서 PPT 새로 만들어줘', { made: true })).toBe(false)
    expect(deskLight('deck', '슬라이드 제목 바꿔줘', {})).toBe(false)
    expect(deskLight('tidy', 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', {})).toBe(true)
    expect(deskLight('keep', '이거 기억해?', {})).toBe(true)
    expect(deskLight('note', '회의록 요약해줘', { given: true })).toBe(true)
    expect(deskLight('note', '회의록 요약해줘', {})).toBe(false)
    expect(deskLight('file', 'sales.csv 합계 알려줘', {})).toBe(false)
    expect(deskLight(undefined, '바꿔줘', { made: true })).toBe(false)
  })
})

describe('a plain "기억해" is kept by the host (M1), and M2, M3 hold on what it kept', () => {
  it('takes the statement in the person\'s words and answers in one line', () => {
    expect(plainKeep('내 이름은 권윤재고 지민호랑 같이 일해. 기억해')).toEqual({ fact: '내 이름은 권윤재고 지민호랑 같이 일해', answer: '기억해 둘게요.' })
    expect(plainKeep('나는 판교에 살아, 기억해 둬')?.fact).toBe('나는 판교에 살아')
    expect(plainKeep('보고서는 표로 받는 게 좋아 기억해줘')?.fact).toBe('보고서는 표로 받는 게 좋아')
    expect(plainKeep('우리 팀 회의는 목요일 오후 2시야! 꼭 잊지 마')?.fact).toBe('우리 팀 회의는 목요일 오후 2시야')
    expect(plainKeep('기억해 둬: 내 생일은 3월 2일이야')?.fact).toBe('내 생일은 3월 2일이야')
    expect(plainKeep('Remember that I work with Minho.', '', false)).toEqual({ fact: 'I work with Minho', answer: 'Got it, I\'ll remember that.' })
    expect(plainKeep('나는 판교에 살아. 기억해', '기억해 둘게요.')?.answer).toBe('이것도 기억해 둘게요.')
    expect(plainKeep('나는 판교에 살아. 기억해')!.answer).not.toMatch(/저장|메모리|기억에/)
  })
  it('leaves a question, a task, a bare remember word and a clause that is no statement to the model', () => {
    for (const ask of ['이거 기억해?', '기억해', '기억해줘', '내 동료는 민호야. 기억해 두고 인사 메일 초안 써줘', '메일 초안 써 주고 기억해', '회의록 정리해줘. 기억해', '내가 민호랑 일한다는 거 기억해', '지난번에 말한 거 기억해 둬', '아 지민호 말고 민호야', '내 이름은 권윤재야.\n기억해'])
      expect(plainKeep(ask), ask).toBeUndefined()
  })
  it('M1 → M2 → M3 against the real memory: the host\'s save, the host\'s correction, what a new thread reads', async () => {
    const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
    await mkdir(paths.notes, { recursive: true })
    const keep = learningTools(paths, 'bot-1', () => '').find(tool => tool.name === 'keep_in_mind')!
    const kept = async () => (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)
    const M1 = '내 이름은 권윤재고 지민호랑 같이 일해. 기억해'
    await keep.run({ facts: [plainKeep(M1)!.fact] }, { task: M1 })
    expect(await kept()).toEqual(['내 이름은 권윤재고 지민호랑 같이 일해'])
    const M2 = '아 지민호 말고 민호야', fix = keptFix(M2, await kept())!
    expect(fix.answer).toBe('민호로 고쳤어요.')
    await keep.run({ facts: [fix.fact], replaces: [fix.old], scope: 'everyone' }, { task: M2 })
    expect(await kept()).toEqual(['내 이름은 권윤재고 민호랑 같이 일해'])
    const note = profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).join('\n')
    expect(note).toContain('민호랑 같이 일해')
    expect(note).not.toContain('지민호')
  })
  it('is made after a correction is tried and before the model is asked', () => {
    expect(ipc).toContain("const keep = !fixed && kind === 'keep' ? plainKeep(request.message,")
    expect(ipc).toContain("if (keptPlain) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'kept-plain' })) }")
    expect(ipc.indexOf('keptFix(request.message, remembered)')).toBeLessThan(ipc.indexOf('plainKeep(request.message,'))
  })
})

describe('recommendations name the trip and are things of that place (H1)', () => {
  it('has one opener rule with one example, and asks for the place\'s own things', () => {
    expect(SHORT_QUESTION_NOTE).toContain('the answer opens with one sentence that names it in the conversation\'s own words and, for picks, says what you went by ("제주 가시면 아버님 무릎 생각해서 덜 걷는 걸로 골랐어요."')
    expect(SHORT_QUESTION_NOTE).toContain('each a thing of that place a person would name (a road, a museum, a market, a dish: "애월 해안도로 드라이브", "오설록 티뮤지엄")')
    expect(SHORT_QUESTION_NOTE).toContain('each with half a clause of why it fits what they told you ("차에서 내려 조금만 걸으면 돼요")')
    expect(SHORT_QUESTION_NOTE).not.toContain('open with what you went by')
    expect(SHORT_QUESTION_NOTE).not.toContain('아버님 무릎 생각해서 많이 안 걷는 걸로 골랐어요.')
    expect(SHORT_QUESTION_NOTE).not.toContain('제주 가시면 이런 게 좋아요.')
    expect(SHORT_QUESTION_NOTE.match(/제주 가시면/g)).toHaveLength(1)
    expect(SHORT_QUESTION_NOTE).not.toContain('never a lunch pick')
    for (const held of ['still no question back', 'you never ask which one they mean', 'fitting what they told you earlier about the thing asked', 'asked for three, give three', 'in Korean words only ("드라이브", never "drive-through 느낌")']) expect(SHORT_QUESTION_NOTE, held).toContain(held)
  })
})

describe('an offer is the next step, never the same content in another shape (H4)', () => {
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  const answer = '한서연: 온보딩 화면 시안 확정 — 11/20까지\n오태민: 결제 모듈 교체 일정 수립 — 11/24까지\n윤가은: 베타 테스터 모집 공지 발송 — 11/27까지'
  async function turn(draft: string, options: AgentLoopOptions = {}) {
    const jobs: ToolSessionJob[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } } } as unknown as Engine
    const result = await runToolSession({ engine, workdir: '/tmp/c8c-desk' as EngineCwd, tools: [] }, ask, { attachmentContext: DESK_NOTE, ...options })
    return { posted: result.answer, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  }
  it('the offer is the model\'s line, asked for by the note\'s example; the host adds none, and the note offers no table or file', async () => {
    const offer = '원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.'
    const { posted, told } = await turn(answer)
    expect(posted).toBe(answer)
    expect(told).toContain(`("${offer}")`)
    expect(DESK_NOTE).toContain('never the same content in another shape (a table, a file)')
    expect([...offer].length).toBeLessThanOrEqual(60)
    const own = `${answer}\n\n${offer}`
    expect((await turn(own)).posted).toBe(own)
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    for (const text of [DESK_NOTE, posted]) expect(text).not.toMatch(/표로 묶어|표로도 정리|워드 파일로도|in a table|Word file/)
  })
  it('dated lines, bare figures and a thread that already had an offer are all posted as written; the once-a-thread rule and the earlier reply are the model\'s to read', async () => {
    for (const draft of ['- 시안 확정: 11월 20일\n- 공지 발송: 11월 27일', '- 38%\n- 12명']) expect((await turn(draft)).posted).toBe(draft)
    const earlier = '정리했어요.\n\n원하시면 워드 파일로도 만들어 드릴게요.'
    const { posted, told } = await turn(answer, { history: [{ role: 'user', text: '회의록 정리해줘' }, { role: 'assistant', text: earlier }] })
    expect(posted).toBe(answer)
    expect(told).toContain('unless an earlier reply of yours in this conversation already ended with an offer')
    expect(told).toContain('원하시면 워드 파일로도 만들어 드릴게요.')
  })
})

describe('first lines across a document thread (D5, F1)', () => {
  it('a third line in a row on one verb ending is a repeat; another ending is not', () => {
    const said = ['회의록 내용 정리할게요.', '장표 흐름 구성할게요.']
    expect(saidBefore('3번 슬라이드 제목 수정할게요.', said)).toBe(true)
    expect(saidBefore('3번 슬라이드 제목 바꿔 볼게요.', said)).toBe(false)
    expect(saidBefore('금방 돼요.', said)).toBe(false)
    expect(saidBefore('제목 수정할게요.', ['회의록 내용 정리할게요.', '장표 흐름 짜볼게요.'])).toBe(false)
    expect(saidBefore('제목 수정할게요.', ['회의록 내용 정리할게요.'])).toBe(false)
  })
  it('the host\'s own line turns the same way, and the voice is told', () => {
    const said = ['회의록 내용 정리할게요.', '장표 흐름 구성할게요.']
    for (const ask of ['fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', '방금 만든 PPT 3번 슬라이드 본문 고쳐줘', '이 문장 번역해줘', '다음 주 일정 요약해줘']) {
      const line = fallbackLine(ask, true, said)
      expect(line, ask).not.toMatch(/할게요\.$/)
      expect(saidBefore(line, said), ask).toBe(false)
    }
    expect(firstLinePrompt('3번 슬라이드 본문 고쳐줘', true, said)).toContain('The last two both end in "…할게요": this one ends another way ("…볼게요.", "금방 돼요.")')
    expect(firstLinePrompt('3번 슬라이드 본문 고쳐줘', true, ['회의록 내용 정리할게요.', '장표 흐름 짜볼게요.'])).not.toContain('The last two both end')
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
