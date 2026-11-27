import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vaultPaths } from '../../../packages/core/src/vault.js'
import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'
import { fileMoveTool } from '../src/main/file-move.js'

const INBOX = ['채용공고_초안.docx', '영수증_사진.png', '출장보고.pdf', '로고_시안.png', '제품소개서.pdf', '할일.txt', '주간보고_44주차.docx', '출장비정산.xlsx', '재고현황.xlsx', '계약서_초안.pdf',
  '좌석배치도.png', '견적서_A사.pdf', '회의자료_1103.pdf', '세금계산서_10월.pdf', '메모.txt', '연락처목록.xlsx', 'wifi_안내.txt', '인사말.docx', '전화메모_1112.txt', '화면캡처_01.png']

describe('c10c F1: the model sorts a folder by kind with its own file_move call', () => {
  let root: string, workspace: string, inbox: string
  const move = () => fileMoveTool(vaultPaths(root), () => {})
  const context = { task: '받은 자료 폴더 확장자 보고 나눠 담아줘' }
  const KIND: Record<string, string> = { pdf: 'PDF', png: '이미지', docx: '문서', xlsx: '엑셀', txt: '텍스트' }
  beforeEach(async () => {
    await mkdir('tmp', { recursive: true })
    root = await mkdtemp(resolve('tmp/c10c-sort-'))
    workspace = vaultPaths(root).workspace
    inbox = join(workspace, 'fixtures', 'inbox-dump')
    await mkdir(inbox, { recursive: true })
    for (const name of INBOX) await writeFile(join(inbox, name), name)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('the ask reaches the model, whose one file_move puts every file in a kind folder and deletes nothing; the thread stores the model\'s words', async () => {
    const jobs: ToolSessionJob[] = []
    const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => {
      jobs.push(job)
      const moves = INBOX.map(name => ({ from: `fixtures/inbox-dump/${name}`, to: `fixtures/inbox-dump/${KIND[name.split('.').pop()!]}/${name}` }))
      await job.tools.find(tool => tool.name === 'file_move')!.run({ moves }, {})
      return { answer: '확장자대로 다섯 폴더에 나눠 담았어요. PDF가 6개로 제일 많아요.' }
    } } as unknown as Engine
    const world = await openWorld(join(root, 'w'), engine)
    inbox = join(world.paths.workspace, 'fixtures', 'inbox-dump')
    await mkdir(inbox, { recursive: true })
    for (const name of INBOX) await writeFile(join(inbox, name), name)
    const { result } = await answer(world, '받은 자료 폴더 확장자 보고 나눠 담아줘')
    expect(jobs).toHaveLength(1)
    expect(result?.answer).toBe('확장자대로 다섯 폴더에 나눠 담았어요. PDF가 6개로 제일 많아요.')
    expect(result?.steps.map(step => step.tool)).toEqual(['file_move'])
    expect(JSON.parse(result!.steps[0]!.observation.split('\n')[0]!)).toMatchObject({ moved: 20, deleted: 0, overwritten: 0 })
    expect((await readdir(inbox)).sort()).toEqual(['PDF', '문서', '엑셀', '이미지', '텍스트'].sort())
    const kept = (await Promise.all(['PDF', '문서', '엑셀', '이미지', '텍스트'].map(folder => readdir(join(inbox, folder))))).flat()
    expect(kept.sort()).toEqual([...INBOX].sort())
    expect(await readFile(join(inbox, '텍스트', '메모.txt'), 'utf8')).toBe('메모.txt')
    expect(world.history.at(-1)).toEqual({ role: 'assistant', text: '확장자대로 다섯 폴더에 나눠 담았어요. PDF가 6개로 제일 많아요.' })
  })

  it('nothing moves when the model makes no move call: the host never sorts on its own', async () => {
    const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async () => ({ answer: '어느 폴더인지 찾아볼게요.' }) } as unknown as Engine
    await answer(await openWorld(root, engine), 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘')
    expect((await readdir(inbox)).sort()).toEqual([...INBOX].sort())
  })

  it('file_move keeps the file a kind folder already holds', async () => {
    await mkdir(join(inbox, 'PDF'))
    await writeFile(join(inbox, 'PDF', '견적서_A사.pdf'), 'older')
    await move().run({ moves: [{ from: 'fixtures/inbox-dump/견적서_A사.pdf', to: 'fixtures/inbox-dump/PDF/견적서_A사.pdf' }] }, context).catch(() => undefined)
    expect(await readFile(join(inbox, 'PDF', '견적서_A사.pdf'), 'utf8')).toBe('older')
  })

  it('file_move moves nothing from outside the workspace', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'a.pdf'), 'a')
    await move().run({ moves: [{ from: join(outside, 'a.pdf'), to: 'fixtures/a.pdf' }] }, context).catch(() => undefined)
    expect(await readdir(outside)).toEqual(['a.pdf'])
  })
})

describe('c10c Q4: reshaping the last reply is quick', () => {
  const LAST = '엔비디아 종가는 135.2달러로, 전일보다 2.1% 올랐어요. [네이버 금융](https://finance.naver.com)'
  async function turn(draft: string, said: string, last?: string) {
    const jobs: ToolSessionJob[] = [], voiced: string[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return 'YES' } } as unknown as Engine
    const result = await runToolSession({ engine, workdir: '/tmp/c10c-desk' as EngineCwd, tools: [] }, said, { ...(last?.trim() ? { history: [{ role: 'user' as const, text: '엔비디아 종가 알려줘' }, { role: 'assistant' as const, text: last }] } : {}) })
    return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  }

  it('gives the model the last reply, the message and the rule for another form, and posts the reply it writes', async () => {
    const reply = '엔비디아는 135.2달러, 2.1% 올랐어요. [네이버 금융](https://finance.naver.com)'
    for (const ask of ['방금 답을 압축해줘', '핵심만 남겨봐', '반말로 해봐', '표로 바꿔줄래', '세 단어로']) {
      const { posted, told, calls } = await turn(reply, ask, LAST)
      expect(posted, ask).toBe(reply)
      expect(told).toContain(LAST)
      expect(told).toContain(`Task: ${ask}`)
      expect(told).toContain('When they ask for your last reply in another form (shorter, as a table, another tone or language), write that reply again in the asked form')
      expect(calls).toBe(1)
    }
    const table = '| 종목 | 종가 | 등락 |\n|---|---|---|\n| 엔비디아 | 135.2달러 | +2.1% |'
    expect((await turn(table, '표로 바꿔줄래', LAST)).posted).toBe(table)
  })

  it('does not ask the quick voice on any message, reshape or not: the reply is the model turn\'s alone', async () => {
    let calls = 0
    for (const [ask, last] of [['방금 답을 압축해줘', undefined], ['방금 답을 압축해줘', '  '], ['fixtures/meeting-notes.md 짧게', LAST], ['report.docx 줄여줘', LAST], ['/짧게', LAST], ['짧게\n영어로', LAST], ['가'.repeat(41), LAST], ['그럼 애플은?', LAST]] as const) {
      const { posted, voiced } = await turn('애플은 아직 안 봤어요.', ask, last)
      expect(posted, ask).toBe('애플은 아직 안 봤어요.')
      calls += voiced.length
    }
    expect(calls).toBe(0)
  })

  it('has no reply of its own in the chat turn: after the host\'s file jobs the model turn is the only writer (stack-10)', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).not.toMatch(/reshape/i)
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain("return runComet({ engine, workdir: engineCwd(paths), tools: menu, ...(imagePaths ? { imagePaths } : {}) }, message, {")
    for (const gone of ['laneNote', 'SHORT_QUESTION_NOTE', 'short: true']) expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8'), gone).not.toContain(gone)
  })
})
