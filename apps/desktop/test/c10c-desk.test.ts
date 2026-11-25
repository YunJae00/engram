import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vaultPaths } from '../../../packages/core/src/vault.js'
import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { DESK_NOTE, deskKind, kindSortAsk, sortByKind } from '../src/main/desk-lane.js'
import { fileMoveTool } from '../src/main/file-move.js'

const INBOX = ['채용공고_초안.docx', '영수증_사진.png', '출장보고.pdf', '로고_시안.png', '제품소개서.pdf', '할일.txt', '주간보고_44주차.docx', '출장비정산.xlsx', '재고현황.xlsx', '계약서_초안.pdf',
  '좌석배치도.png', '견적서_A사.pdf', '회의자료_1103.pdf', '세금계산서_10월.pdf', '메모.txt', '연락처목록.xlsx', 'wifi_안내.txt', '인사말.docx', '전화메모_1112.txt', '화면캡처_01.png']
const F1 = 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘'

describe('c10c F1: the host sorts one folder by kind', () => {
  let root: string, workspace: string, inbox: string
  const move = () => fileMoveTool(vaultPaths(root), () => {})
  const context = { task: F1 }
  beforeEach(async () => {
    await mkdir('tmp', { recursive: true })
    root = await mkdtemp(resolve('tmp/c10c-sort-'))
    workspace = vaultPaths(root).workspace
    inbox = join(workspace, 'fixtures', 'inbox-dump')
    await mkdir(inbox, { recursive: true })
    for (const name of INBOX) await writeFile(join(inbox, name), name)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('sorts the folder whatever the sentence shape, and leaves other asks to the model', async () => {
    expect(deskKind(F1)).toBe('tidy')
    const yes = [F1, 'fixtures/inbox-dump에 있는 파일을 종류별로 정리해줘', '이 폴더 fixtures/inbox-dump 파일들 종류별로 정리해줘',
      '"fixtures/inbox-dump" 안의 자료 형식별로 분류해 주세요.', '받은 파일 모아둔 fixtures/inbox-dump/ 좀 확장자별로 나눠줘', 'fixtures/inbox-dump의 파일들 파일유형별로 정리해 줄래']
    for (const ask of yes) {
      expect(kindSortAsk(ask), ask).toBeDefined()
      const sorted = await sortByKind(ask, workspace, move(), context)
      expect(sorted?.answer, ask).toContain('- PDF 6개')
      for (const folder of ['PDF', '문서', '엑셀', '이미지', '텍스트']) for (const name of await readdir(join(inbox, folder))) await rename(join(inbox, folder, name), join(inbox, name))
      for (const folder of ['PDF', '문서', '엑셀', '이미지', '텍스트']) await rmdir(join(inbox, folder))
    }
    await writeFile(join(workspace, 'fixtures', 'meeting-notes.md'), '# 회의')
    await mkdir(join(workspace, 'fixtures', 'other'))
    const no = ['fixtures/inbox-dump 폴더 날짜별로 정리해줘', 'fixtures/inbox-dump에 있는 파일들 프로젝트별로 정리해줘', 'fixtures/inbox-dump fixtures/other 정리해줘',
      'fixtures/meeting-notes.md 정리해줘', 'fixtures/inbox-dump 폴더 정리하고 오래된 건 지워줘', '폴더 정리해줘', 'fixtures/inbox-dump 폴더 정리해서 민호한테 보내줘',
      'fixtures/inbox-dump에서 PDF만 종류별로 정리해줘', 'fixtures/inbox-dump 정리하지 마', 'fixtures/nowhere 종류별로 정리해줘',
      'fixtures/inbox-dump 파일들을 이름순으로 정리해줘', 'fixtures/inbox-dump 날짜순으로 정리해줘', 'fixtures/inbox-dump 크기대로 나눠줘', 'fixtures/inbox-dump 거래처마다 분류해줘', 'fixtures/inbox-dump 정리해줘']
    for (const ask of no) expect(await sortByKind(ask, workspace, move(), context), ask).toBeUndefined()
    expect((await readdir(inbox)).sort()).toEqual([...INBOX].sort())
  })

  it('moves every file into Korean kind folders in one file_move, deletes nothing and answers with the counts', async () => {
    const sorted = await sortByKind(F1, workspace, move(), context)
    expect(sorted?.answer).toBe('종류별 폴더로 옮겼어요.\n\n- PDF 6개\n- 이미지 4개\n- 텍스트 4개\n- 문서 3개\n- 엑셀 3개')
    expect(sorted?.steps).toHaveLength(1)
    expect(sorted?.steps[0]!.tool).toBe('file_move')
    expect(JSON.parse(sorted!.steps[0]!.observation)).toMatchObject({ moved: 20, deleted: 0, overwritten: 0 })
    expect((await readdir(inbox)).sort()).toEqual(['PDF', '문서', '엑셀', '이미지', '텍스트'].sort())
    expect((await readdir(join(inbox, 'PDF'))).length).toBe(6)
    const kept = (await Promise.all(['PDF', '문서', '엑셀', '이미지', '텍스트'].map(folder => readdir(join(inbox, folder))))).flat()
    expect(kept.sort()).toEqual([...INBOX].sort())
    expect(await readFile(join(inbox, '텍스트', '메모.txt'), 'utf8')).toBe('메모.txt')
  })

  it('keeps both files when a kind folder already holds the name', async () => {
    await mkdir(join(inbox, 'PDF'))
    await writeFile(join(inbox, 'PDF', '견적서_A사.pdf'), 'older')
    const sorted = await sortByKind(F1, workspace, move(), context)
    expect(sorted?.answer).toContain('- PDF 6개')
    expect(sorted?.answer).toContain('-2를 붙여서 둘 다 남겼어요.')
    expect(await readFile(join(inbox, 'PDF', '견적서_A사.pdf'), 'utf8')).toBe('older')
    expect(await readFile(join(inbox, 'PDF', '견적서_A사-2.pdf'), 'utf8')).toBe('견적서_A사.pdf')
  })

  it('leaves a folder outside the workspace, a folder of folders and an empty one to the model, moving nothing', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'a.pdf'), 'a')
    expect(await sortByKind('../outside 폴더 종류별로 정리해줘', workspace, move(), context)).toBeUndefined()
    expect(await sortByKind(`${outside} 폴더 종류별로 정리해줘`, workspace, move(), context)).toBeUndefined()
    expect(await readdir(outside)).toEqual(['a.pdf'])
    await mkdir(join(inbox, '2024'))
    expect(await sortByKind(F1, workspace, move(), context)).toBeUndefined()
    expect((await readdir(inbox)).length).toBe(21)
    await mkdir(join(workspace, 'empty', 'box'), { recursive: true })
    expect(await sortByKind('empty/box 정리해줘', workspace, move(), context)).toBeUndefined()
  })

  it('moves nothing into Engram\'s own folders: file_move refuses and the model takes it', async () => {
    const tasks = join(workspace, 'tasks', 'bot-one')
    await mkdir(tasks, { recursive: true })
    await writeFile(join(tasks, 'x.pdf'), 'x')
    expect(await sortByKind('tasks/bot-one 종류별로 정리해줘', workspace, move(), context)).toBeUndefined()
    expect(await readdir(tasks)).toEqual(['x.pdf'])
  })
})

describe('c10c Q4: reshaping the last reply is quick', () => {
  const LAST = '엔비디아 종가는 135.2달러로, 전일보다 2.1% 올랐어요. [네이버 금융](https://finance.naver.com)'
  async function turn(draft: string, said: string, last?: string) {
    const jobs: ToolSessionJob[] = [], voiced: string[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return 'YES' } } as unknown as Engine
    const result = await runToolSession({ engine, workdir: '/tmp/c10c-desk' as EngineCwd, tools: [] }, said, { short: true, ...(last?.trim() ? { history: [{ role: 'user' as const, text: '엔비디아 종가 알려줘' }, { role: 'assistant' as const, text: last }] } : {}) })
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
    expect(ipc).toContain(': retitled ? { ...retitled, fellBack: false } : sorted ? { ...sorted, fellBack: false } : await answer({ paths, botId: bot.id, engine: team.leadEngine(channel, engine),')
    expect(ipc).toContain('...([SHORT_QUESTION_NOTE, SMALL_TALK_NOTE, TOLD_NOTE].includes(laneNote) ? { short: true } : {}),')
  })
})

describe('c10c D3: the desk note no longer expects a second build', () => {
  it('tells the model a saved file is not read back or built again', () => {
    expect(DESK_NOTE).not.toContain('built twice')
    expect(DESK_NOTE).toContain('After ppt_build, word_write or file_create_workbook says the file is saved, do not read it back or build it again')
  })
})
