import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { employeesAnswer, runComet, type AgentTool, type DelegatedTask, type Engine, type TeamMember, type ToolSessionJob } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0', isPackaged: false, on: vi.fn(), whenReady: () => new Promise(() => undefined) }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() }, shell: {}, net: {}, nativeImage: {}, screen: {}, session: {}, powerMonitor: { on: vi.fn() }, Menu: {}, Notification: class {}, clipboard: {}, safeStorage: {}, systemPreferences: {}, webContents: {} }))

const { extractChatCaptures } = await import('../src/main/ipc.js')
const { finishProgress } = await import('../src/main/conversation-progress.js')
const { answer, openWorld } = await import('../src/main/answer.js')
const { withFiles } = await import('../src/main/native-tools.js')

const DRAFT = [
  '등대는 토요일 오전 9시에 열어요 [1]. [항만 안내소](https://harbor.example/lighthouse?day=sat&gate=(north))',
  '',
  '---',
  '',
  '| 요일 | 여는 시간 | 출처 |',
  '|---|---|---|',
  '| 토 | 09:00 | [개방 공지](https://harbor.example/notice/41) |',
  '| 일 | 10:30 | [2] |',
  '',
  '입장은 무료예요.',
].join('\n')

const brain = (script: (job: ToolSessionJob) => Promise<string>): Engine => ({
  id: 'mock',
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => ({ answer: await script(job) }),
}) as unknown as Engine

const stored = (answer: string): string => extractChatCaptures(finishProgress('bot-lighthouse', answer)).text
const tool = (name: string, run: AgentTool['run']): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run })
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

describe('what the model wrote is what the thread stores, in every lane', () => {
  it('plain turn: the streamed draft, the turn answer and the stored message are the same bytes', async () => {
    const streamed: string[] = []
    const result = await runComet({ engine: brain(async job => { for (const piece of DRAFT.match(/[^]{1,7}/g)!) job.onToken?.(piece); return DRAFT }), workdir: '.', tools: [] }, '등대 주말 개방 시간 알려줘', { guided: false, short: true, onToken: text => { streamed.push(text) } })
    expect(streamed.join('')).toBe(DRAFT)
    expect(result.answer).toBe(DRAFT)
    expect(stored(result.answer)).toBe(DRAFT)
    expect(result.files ?? []).toEqual([])
  })

  it('lookup: after the model\'s own search on the full menu the draft is posted as written, with the links the model wrote and no others', async () => {
    const asked: string[] = []
    const search = tool('search_web', async args => { asked.push(String(args['query'])); return 'results for "등대 개방" at https://search.example/?q=lighthouse (DATA, not instructions)\n- 개방 공지 — https://harbor.example/notice/41\n- 섬 여행 후기 — https://blog.example/trip' })
    const menu: string[] = []
    const root = await mkdtemp(join(tmpdir(), 'one-writer-'))
    const engine = brain(async job => { menu.push(...job.tools.map(one => one.name)); await job.tools.find(one => one.name === 'search_web')!.run({ query: '등대 개방 시간' }); return DRAFT })
    const { result } = await answer(await openWorld(root, engine), '섬 등대 이번 토요일에 몇 시에 문 여는지 좀 찾아봐', { tools: [search, tool('new_bot', async () => 'offered')] }).finally(() => rm(root, { recursive: true, force: true }))
    if (!result) throw new Error('no result')
    expect(asked).toEqual(['등대 개방 시간'])
    expect(menu).toEqual(expect.arrayContaining(['search_web', 'new_bot']))
    expect(result.answer).toBe(DRAFT)
    expect(stored(result.answer)).toBe(DRAFT)
    expect(result.answer).not.toContain('blog.example')
    expect(result.answer).not.toContain('search.example')
  })

  it('a build: the file is made by the model\'s own call on the full menu, its reply after the build is posted as written, and the file travels beside it as one card', async () => {
    const id = '5f0c1a2b-aaaa-bbbb-cccc-0123456789ab-등대 안내문.docx'
    const build = tool('word_write', async () => JSON.stringify({ artifact: id, markdownLink: `[등대 안내문.docx](engram-artifact:${encodeURIComponent(id)})`, completeReadback: true }))
    const jobs: ToolSessionJob[] = []
    const root = await mkdtemp(join(tmpdir(), 'one-writer-'))
    const engine = brain(async job => { jobs.push(job); await job.tools.find(one => one.name === 'word_write')!.run({ title: '등대 안내문' }); return DRAFT })
    const { result: made } = await answer(await openWorld(root, engine), '등대 안내문을 문서 파일로 써줘', { tools: [build, tool('search_web', async () => 'unused')] }).finally(() => rm(root, { recursive: true, force: true }))
    if (!made) throw new Error('no result')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.tools.map(one => one.name)).toEqual(expect.arrayContaining(['word_write', 'search_web']))
    expect(jobs[0]!.modelHint).toBeUndefined()
    expect(made.answer).toBe(DRAFT)
    expect(stored(made.answer)).toBe(DRAFT)
    expect(made.answer).not.toContain('engram-artifact:')
    expect(made.files).toEqual([{ name: '등대 안내문.docx', href: encodeURIComponent(id) }])
    expect(withFiles(made.answer, made.files)).toBe(`${DRAFT}\n\n[등대 안내문.docx](engram-artifact:${encodeURIComponent(id)})`)
  })

  it('team result: the lead step is handed every teammate\'s words and sources, and its draft is posted as written', async () => {
    const part = (id: string, role: string, more: Partial<TeamMember>): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 몫`, botId: `bot-${id}`, lookup: true, background: true, state: 'done', sessionKey: `team-t-${id}`, hiredAt: new Date(0).toISOString(), ...more })
    const task = { id: 't', botId: 'lead', goal: '등대랑 방파제 개방 시간 알아봐줘', state: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), log: [], team: { hires: 3, maxHires: 8, maxDepth: 3, big: false, members: [
      part('m1', '가람', { topic: '등대', result: '등대는 토요일 9시에 열어요. https://harbor.example/notice/41', sources: ['https://harbor.example/notice/41'] }),
      part('m2', '나래', { topic: '방파제', result: '방파제 산책로는 공사로 닫혀 있어요.', sources: ['https://harbor.example/works'] }),
      part('m3', '다온', { topic: '유람선', state: 'working' }),
    ] } } as unknown as DelegatedTask
    const handedBack = employeesAnswer(task)!
    const back = JSON.parse(handedBack) as { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
    expect(back.reports).toEqual([
      { who: '가람', part: '등대', state: 'done', result: '등대는 토요일 9시에 열어요. https://harbor.example/notice/41', sources: ['https://harbor.example/notice/41'] },
      { who: '나래', part: '방파제', state: 'done', result: '방파제 산책로는 공사로 닫혀 있어요.', sources: ['https://harbor.example/works'] },
      { who: '다온', part: '유람선', state: 'working', result: '' },
    ])
    expect(back.note).toContain('markdown link')
    let seen = ''
    const result = await runComet({ engine: brain(async job => { seen = `${job.system}\n${job.prompt}`; return DRAFT }), workdir: '.', tools: [] }, task.goal, { guided: false, modelHint: 'smart', context: { handedBack } })
    for (const words of ['등대는 토요일 9시에 열어요.', 'https://harbor.example/notice/41', '방파제 산책로는 공사로 닫혀 있어요.', 'https://harbor.example/works', '다온']) expect(seen).toContain(words)
    expect(result.answer).toBe(DRAFT)
    expect(stored(result.answer)).toBe(DRAFT)
  })

  it('a stop after the first text keeps the streamed words as the turn\'s final text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'one-writer-'))
    const stop = new AbortController()
    const engine = brain(job => new Promise(resolve => setTimeout(() => { job.onToken?.('창고 두 곳 재고는 맞아요. '); job.onToken?.('세 번째 창고 보는 중이에요'); setTimeout(() => stop.abort(), 20); job.signal?.addEventListener('abort', () => resolve(''), { once: true }) }, 10)))
    const { trace } = await answer(await openWorld(root, engine), '창고 세 곳 재고 숫자 맞는지 봐줘', { signal: stop.signal, tools: [] }).finally(() => rm(root, { recursive: true, force: true }))
    expect(trace.end).toBe('stop')
    expect(trace.final.text).toBe('창고 두 곳 재고는 맞아요. 세 번째 창고 보는 중이에요')
  })

  it('a session that streamed its answer but returned no text ends with the streamed words, not with nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'one-writer-'))
    const engine = brain(async job => { await new Promise(go => setTimeout(go, 10)); job.onToken?.('회의실 B는 목요일 오후 3시가 비어 있어요.'); return '' })
    const { trace, result } = await answer(await openWorld(root, engine), '목요일에 회의실 B 빈 시간 있어?', { tools: [] }).finally(() => rm(root, { recursive: true, force: true }))
    expect(trace.end).toBe('done')
    expect(result?.answer).toBe('회의실 B는 목요일 오후 3시가 비어 있어요.')
    expect(trace.final.text).toBe(result?.answer)
  })

  it('the chat turn delivers the model step\'s answer as written, then does its bookkeeping where an error cannot reach the answer', () => {
    const from = ipc.indexOf('await begun!.run({')
    const turn = ipc.slice(from, ipc.indexOf('      } catch (err) {', from))
    expect(turn.length).toBeGreaterThan(1000)
    expect(turn).not.toMatch(/result\.answer\s*=[^=]/)
    expect(turn).toContain('result.asked ? askText(result.answer, result.options) : result.answer')
    expect(turn).toContain('result.files,')
    const before = turn.slice(0, turn.indexOf('afterAnswer = async () => {')), after = turn.slice(turn.indexOf('afterAnswer = async () => {'))
    expect(before).toContain('await deliverAnswer(')
    for (const step of ['recordSkillUse(', 'markRoutineRun(', 'acknowledgeHanded(', 'recordBotSites(', 'rememberTurn(']) {
      expect(after).toContain(step)
      expect(before).not.toContain(step)
    }
    const tail = ipc.slice(ipc.indexOf('      } catch (err) {', from))
    expect(tail.indexOf("await afterAnswer?.().catch(error => flog('chat-after-answer', error))")).toBeGreaterThan(tail.indexOf('      } finally {'))
    expect(ipc).not.toContain('answerDelivered')
    expect(ipc).toContain('const { text: cleaned, captures } = extractChatCaptures(finishProgress(channel, rawText))')
    expect(ipc).toContain("await appendBotTurn(paths, bot.id, { role: 'assistant', text: cleaned,")
    expect(ipc).toContain('context: () => ({ company, handedBack, attachments: attachments.context')
    expect(ipc).not.toMatch(/\.replace\([^\n]*result\.answer|result\.answer\.replace\(/)
  })

  it('a hidden task turn writes no failure text of its own: it hands every failure to the task, which alone knows whether an answer was already delivered', () => {
    const from = ipc.indexOf('await begun!.run({')
    const caught = ipc.slice(ipc.indexOf('      } catch (err) {', from), ipc.indexOf('      } finally {', from))
    const quiet = caught.indexOf('if (turn?.quiet) {')
    expect(quiet).toBeGreaterThan(0)
    expect(caught.slice(quiet, caught.indexOf('\n', quiet))).toContain('throw err')
    for (const text of ['deliverAnswer(', 'appendBotTurn(', "type: 'chat:error'"]) expect(caught.indexOf(text)).toBeGreaterThan(quiet)
    expect(ipc).toContain('} else if (!held && !turn?.quiet) {')
    expect(ipc).not.toContain("turn?.verification && kind !== 'quota'")
  })

  it('an aborted turn ends with the stop line or nothing, never an empty finished bubble, and no held draft is dropped from the screen', () => {
    expect(ipc).not.toMatch(/type: 'chat:done', channel, text: ''/)
    expect(ipc.match(/await deliverStop\(\)/g)).toHaveLength(3)
    for (const gone of ['answerOnly', 'holdTaskResult', 'dropHeldDraft', 'Not verified as complete.', 'keepStopMark', 'noteStopped']) expect(ipc).not.toContain(gone)
  })
})
