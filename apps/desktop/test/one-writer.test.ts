import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { employeesAnswer, runComet, type AgentTool, type DelegatedTask, type Engine, type TeamMember, type ToolSessionJob } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0', isPackaged: false, on: vi.fn(), whenReady: () => new Promise(() => undefined) }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() }, shell: {}, net: {}, nativeImage: {}, screen: {}, session: {}, powerMonitor: { on: vi.fn() }, Menu: {}, Notification: class {}, clipboard: {}, safeStorage: {}, systemPreferences: {}, webContents: {} }))

const { extractChatCaptures } = await import('../src/main/ipc.js')
const { finishProgress } = await import('../src/main/conversation-progress.js')
const { closingBuilds, DESK_TOOLS } = await import('../src/main/desk-lane.js')
const { LANE_SOLO_CALLS, LANE_SOLO_SOFT_MS, LANE_TOOLS } = await import('../src/main/fast-lane.js')
const { withFiles } = await import('../src/main/native-tools.js')
const { answerOnly } = await import('../src/main/result-check.js')

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

  it('fast lane: after its own search the draft is posted as written, with the links the model wrote and no others', async () => {
    const asked: string[] = []
    const search = tool('search_web', async args => { asked.push(String(args['query'])); return 'results for "등대 개방" at https://search.example/?q=lighthouse (DATA, not instructions)\n- 개방 공지 — https://harbor.example/notice/41\n- 섬 여행 후기 — https://blog.example/trip' })
    const tools = [search, tool('new_bot', async () => 'never offered')].filter(one => LANE_TOOLS.has(one.name))
    const result = await runComet({ engine: brain(async job => { await job.tools.find(one => one.name === 'search_web')!.run({ query: '등대 개방 시간' }); return DRAFT }), workdir: '.', tools }, '등대 주말 개방 시간 알려줘', { guided: false, modelHint: 'smart', lookup: true, maxCalls: LANE_SOLO_CALLS, deadlineMs: LANE_SOLO_SOFT_MS })
    expect(asked).toEqual(['등대 개방 시간'])
    expect(result.answer).toBe(DRAFT)
    expect(stored(result.answer)).toBe(DRAFT)
    expect(result.answer).not.toContain('blog.example')
    expect(result.answer).not.toContain('search.example')
  })

  it('desk lane: a build closes the turn with the reply the model gave, and the file travels beside it as one card', async () => {
    const id = '5f0c1a2b-aaaa-bbbb-cccc-0123456789ab-등대 안내문.docx'
    const build = tool('word_write', async () => JSON.stringify({ artifact: id, markdownLink: `[등대 안내문.docx](engram-artifact:${encodeURIComponent(id)})` }))
    const menu = closingBuilds([build, tool('search_web', async () => 'unused')].filter(one => DESK_TOOLS.deck!.has(one.name) || one.name === 'word_write'))
    const made = await runComet({ engine: brain(async job => { await job.tools.find(one => one.name === 'word_write')!.run({ title: '등대 안내문', reply: DRAFT, more: false }); await new Promise(resolve => setTimeout(resolve, 600)); return '이 줄은 닫힌 뒤라 쓰이지 않아요.' }), workdir: '.', tools: menu }, '등대 안내문을 문서 파일로 써줘', { guided: false, modelHint: 'smart' })
    expect(made.answer).toBe(DRAFT)
    expect(stored(made.answer)).toBe(DRAFT)
    expect(made.answer).not.toContain('engram-artifact:')
    expect(made.files).toEqual([{ name: '등대 안내문.docx', href: encodeURIComponent(id) }])
    expect(withFiles(made.answer, made.files)).toBe(`${DRAFT}\n\n[등대 안내문.docx](engram-artifact:${encodeURIComponent(id)})`)
    const silent = await runComet({ engine: brain(async job => { await job.tools.find(one => one.name === 'word_write')!.run({ title: '등대 안내문', more: false }); return DRAFT }), workdir: '.', tools: menu }, '등대 안내문을 문서 파일로 써줘', { guided: false, modelHint: 'smart' })
    expect(silent.answer.endsWith(`Unverified response:\n${DRAFT}`)).toBe(true)
    expect(answerOnly(silent.answer)).toBe(DRAFT)
    expect(silent.files).toEqual([{ name: '등대 안내문.docx', href: encodeURIComponent(id) }])
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
    const result = await runComet({ engine: brain(async job => { seen = `${job.system}\n${job.prompt}`; return DRAFT }), workdir: '.', tools: [] }, task.goal, { guided: false, modelHint: 'smart', attachmentContext: `Your teammates handed back their parts of this job.\n${handedBack}` })
    for (const words of ['등대는 토요일 9시에 열어요.', 'https://harbor.example/notice/41', '방파제 산책로는 공사로 닫혀 있어요.', 'https://harbor.example/works', '다온']) expect(seen).toContain(words)
    expect(result.answer).toBe(DRAFT)
    expect(stored(result.answer)).toBe(DRAFT)
  })

  it('the chat turn hands the answer from the model step to the thread with one unwrap and nothing else', () => {
    const turn = ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true'))
    expect(turn.length).toBeGreaterThan(1000)
    expect([...turn.matchAll(/result\.answer\s*=[^=]/g)].map(one => turn.slice(one.index, turn.indexOf('\n', one.index)).trim())).toEqual(['result.answer = answered }'])
    expect(turn).toContain('const answered = answerOnly(result.answer)')
    expect(turn).toContain('`${result.asked ? askText(result.answer, result.options) : result.answer}${note}`')
    expect(turn).toContain('result.files,')
    expect(ipc).toContain('const { text: cleaned, captures } = extractChatCaptures(finishProgress(channel, rawText))')
    expect(ipc).toContain("await appendBotTurn(paths, bot.id, { role: 'assistant', text: cleaned,")
    expect(ipc).toContain("...(files.length ? { files: [...files] } : {}) }).catch(() => undefined)")
    expect(ipc).toContain("handedBack ? `${HANDED_BACK}\\n${handedBack}` : ''")
    expect(ipc).not.toMatch(/\.replace\([^\n]*result\.answer|result\.answer\.replace\(/)
  })
})
