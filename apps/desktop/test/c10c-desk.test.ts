import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vaultPaths } from '../../../packages/core/src/vault.js'
import { DESK_NOTE, deskKind, kindSortAsk, reshapeAsk, sortByKind } from '../src/main/desk-lane.js'
import { fileMoveTool } from '../src/main/file-move.js'

// The harness fixture tmp/grokbar/fixtures/inbox-dump, by name: 6 PDF, 4 PNG, 3 XLSX, 3 DOCX, 4 TXT.
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

  it('matches a plain sort-by-kind ask and nothing else', () => {
    expect(deskKind(F1)).toBe('tidy')
    for (const ask of [F1, 'fixtures/inbox-dump 정리해줘', 'fixtures/inbox-dump 폴더 형식별로 분류해줘', 'fixtures/inbox-dump/ 파일 확장자별로 정리해 주세요.', 'fixtures/inbox-dump 폴더 종류별로 나눠줘'])
      expect(kindSortAsk(ask)).toBe('fixtures/inbox-dump')
    for (const ask of ['fixtures/inbox-dump 폴더 날짜별로 정리해줘', 'fixtures/inbox-dump 폴더 파일들 프로젝트별로 정리해줘', 'fixtures/a fixtures/b 정리해줘',
      'fixtures/meeting-notes.md 정리해줘', 'fixtures/inbox-dump 폴더 정리하고 오래된 건 지워줘', '폴더 정리해줘', 'fixtures/inbox-dump 폴더 정리해서 민호한테 보내줘'])
      expect(kindSortAsk(ask)).toBeUndefined()
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
  it('matches a short reshape of the last reply and not new work', () => {
    for (const ask of ['방금 말한 거 더 짧게', '더 짧게', '짧게 줄여줘', '다시 써줘', '더 정중하게', '영어로', '한 줄로', '방금 말한 거 한 줄로 줄여줘', '좀 더 부드럽게 다시 써줘', 'make it shorter'])
      expect(reshapeAsk(ask), ask).toBe(true)
    for (const ask of ['더 짧은 회의록 만들어줘', '영어로 메일 보내줘', '민호한테 더 정중하게 보내줘', 'fixtures/meeting-notes.md 짧게 정리해줘', '엔비디아 주가 다시 찾아줘', '이거 영어로 워드 파일 만들어줘', '1년은 몇 초야?', '고마워'])
      expect(reshapeAsk(ask), ask).toBe(false)
    // The global file-name pattern is matched without carrying state from one call to the next.
    expect([reshapeAsk('더 짧게'), reshapeAsk('더 짧게')]).toEqual([true, true])
  })

  it('runs on the fast tier at low effort, with no tools, no shell and only the recent turns', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).toContain('const reshape = !company && !lane && plainAsk && !handed && reshapeAsk(request.message) && !!lastReplyOf(')
    expect(ipc).toContain('deskMenu = reshape ? new Set<string>() : kind && DESK_TOOLS[kind]')
    expect(ipc).toMatch(/\.\.\.\(desk \? \{ modelHint: 'smart' as const[^\n]*\n[^\n]*\n\s*\.\.\.\(reshape \? \{ modelHint: 'fast' as const, light: true \} : \{\}\),/)
    expect(ipc).toContain('history: (reshape ? savedHistory.slice(-RESHAPE_TURNS) : savedHistory)')
    expect(ipc).toContain('...(native && !lane && !company && !reshape ? { native } : {}),')
  })
})

describe('c10c D3: the desk note no longer expects a second build', () => {
  it('tells the model a saved file is not read back or built again', () => {
    expect(DESK_NOTE).not.toContain('built twice')
    expect(DESK_NOTE).toContain('After ppt_build, word_write or file_create_workbook says the file is saved, do not read it back or build it again')
  })
})
