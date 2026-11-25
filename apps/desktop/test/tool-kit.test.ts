import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initVault, type AgentTool, type VaultPaths } from 'core'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => `${state.home}/${name}`, isPackaged: false }, net: {}, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }, nativeImage: {}, BrowserWindow: class {}, session: {}, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) } }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
vi.mock('../src/main/agent-view.js', () => ({ touchedAt: () => 0 }))
vi.mock('../src/main/office-host.js', () => ({ officeApps: () => ({ word: true, powerpoint: true, excel: true, outlook: true }), officeSupported: () => true, officeRequest: vi.fn() }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: vi.fn() }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn(), officeWorkPreview: () => () => {} }))
vi.mock('../src/main/application-work.js', () => ({ applicationWork: () => ({ signal: undefined, show: vi.fn() }), clearApplicationWork: vi.fn() }))

const { toolKit } = await import('../src/main/tool-kit.js')
const { appFileHost } = await import('../src/main/file-host.js')
const { appCourier } = await import('../src/main/app-courier.js')
const { agentCourier } = await import('../src/main/agent-courier.js')
const { officeAgentTools } = await import('../src/main/office-live.js')
const { taskOutputs } = await import('../src/main/file-work.js')
const { readFileSync } = await import('node:fs')

type Inputs = Parameters<typeof toolKit>[0]
type Ask = NonNullable<NonNullable<Inputs['files']>['consent']['ask']>

const THEME = { field: '#204030', accent: '#C08020', fonts: { title: 'Georgia', body: 'Verdana' } }
const offline = { fetch: () => Promise.reject(new Error('offline')), follow: async () => null }
const plainHost = (home: string) => ({ app: { getPath: (name: string) => join(home, name) }, assertDesktopTurnNotStopped: () => undefined })
const shape = (tools: AgentTool[]) => tools.map(tool => ({ name: tool.name, description: tool.description, schema: JSON.stringify(tool.argsSchema) }))

let root: string, paths: VaultPaths, work: string
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await realpath(await mkdtemp(resolve('tmp/tool-kit-')))
  state.home = join(root, 'home')
  paths = await initVault(join(root, 'vault'), { git: false })
  work = join(paths.workspace, 'tasks', 'bot-orchard')
  await mkdir(work, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const schedule = { list: async () => [], add: async () => { throw new Error('not in this test') }, remove: async () => false, watchable: ['notifications'] }

function kitFor(how: 'app' | 'plain', ask: Ask = async () => 'approve', chief = false, korean = false) {
  const made = new Set<string>()
  return toolKit({
    paths, channel: 'bot-orchard', log: () => undefined, retrieve: async () => [],
    courier: how === 'app' ? appCourier({ lane: 'bot-orchard' }) : agentCourier({ network: offline, touchedAt: () => 0, lane: 'bot-orchard' }),
    bot: { schedule, chief, changed: () => undefined, said: () => '' },
    files: { readable: [], workFolder: work, consent: { ask, korean: () => korean, made, turn: 't-1' }, host: how === 'app' ? appFileHost : plainHost(state.home) },
    office: { outputs: taskOutputs(paths, async () => work, made, 't-1'), personal: '', assertActive: () => undefined },
  })
}

const appOffice = () => officeAgentTools('bot-orchard', taskOutputs(paths, async () => work, new Set(), 't-1')).filter(tool => tool.name === 'word_write' || tool.name === 'ppt_build')

const facts = (text: string) => JSON.parse(text.split(root).join('<root>').replace(/[0-9a-f]{64}/g, '<sha>').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '<id>')) as unknown

describe('the tool kit built from plain inputs', () => {
  it('offers, per group, the same names, descriptions and schemas as the app wiring', () => {
    for (const chief of [false, true]) {
      const app = kitFor('app', undefined, chief), plain = kitFor('plain', undefined, chief)
      expect(shape(plain.web)).toEqual(shape(app.web))
      expect(shape(plain.team)).toEqual(shape(app.team))
      expect(shape(plain.learning)).toEqual(shape(app.learning))
      expect(shape(plain.office)).toEqual(shape(app.office))
      expect(shape(plain.files)).toEqual(shape(app.files.filter(tool => tool.name !== 'render_file')))
      expect(app.files.map(tool => tool.name).filter(name => !plain.files.some(tool => tool.name === name))).toEqual(['render_file'])
    }
    expect(kitFor('plain').team.map(tool => tool.name)).toEqual(['schedule', 'new_bot'])
    expect(kitFor('plain', undefined, true).team.map(tool => tool.name)).toEqual(['schedule', 'agents', 'agents_now'])
    expect(shape(kitFor('plain').office)).toEqual(shape(appOffice()))
    expect(kitFor('plain').web.map(tool => tool.name)).toEqual(expect.arrayContaining(['search_web', 'open_page', 'search_memory']))
  })

  it('is what the chat send path spreads, at the places its tools held in the menu', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const set = ipc.slice(ipc.indexOf('const cometToolSet = async'), ipc.indexOf('async function handleChatSend'))
    const at = (piece: string) => { const found = set.indexOf(piece); expect(found, piece).toBeGreaterThan(0); return found }
    const order = ['const kit = toolKit({', 'return [...kit.web, ...workEvidenceTools(paths, channel), ...attachments.tools,', '...kit.team, ...team.tools(', 'deskActivityTool,', '...kit.learning,', 'helpersTool({', 'resultCheckTool(', '...kit.files, ...appTools]'].map(at)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const gone of ['cometTools(', 'cometFileTools(', 'learningTools(', 'scheduleTool(', 'teamTool(', 'staffTool(']) expect(set).not.toContain(gone)
  })

  it('moves, reads and builds with the same returned facts as the app wiring', async () => {
    const runAll = async (kit: ReturnType<typeof kitFor>, office: AgentTool[]) => {
      const tool = (name: string) => [...kit.files, ...office].find(one => one.name === name)!
      await mkdir(join(paths.workspace, 'garden'), { recursive: true })
      await writeFile(join(paths.workspace, 'garden', 'seeds.txt'), '토마토 12\n바질 7\n')
      const read = await tool('file_read').run({ path: join(paths.workspace, 'garden', 'seeds.txt') }, { task: '씨앗 목록 읽어줘' })
      const moved = await tool('file_move').run({ moves: [{ from: 'garden/seeds.txt', to: 'garden/spring/seeds.txt' }] }, { task: '봄 폴더로 옮겨줘' })
      const sheet = await tool('file_create_workbook').run({ name: 'harvest.xlsx', sheet: 'Harvest', rows: [['crop', 'kg'], ['tomato', 4]] }, { task: '수확표 만들어줘' })
      const doc = await tool('word_write').run({ title: '텃밭 일지', blocks: [{ kind: 'title', text: '텃밭 일지' }, { kind: 'paragraph', text: '토마토가 익었어요.' }], theme: THEME }, { task: '일지 문서로 써줘' })
      await rm(join(paths.workspace, 'garden'), { recursive: true, force: true })
      await rm(work, { recursive: true, force: true })
      await mkdir(work, { recursive: true })
      const { bytes, ...stamped } = facts(doc) as { bytes: number }
      expect(bytes).toBeGreaterThan(1000)
      return [...[read, moved, sheet].map(facts), stamped]
    }
    const app = await runAll(kitFor('app'), appOffice())
    const plain = await runAll(kitFor('plain'), kitFor('plain').office)
    expect(plain).toEqual(app)
    expect((plain[1] as { moved: number }).moved).toBe(1)
  })

  it('asks before reading outside the box and refuses on a no, exactly as the app wiring does', async () => {
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    const outside = join(root, 'elsewhere', 'ledger.txt')
    await writeFile(outside, '장부')
    await writeFile(join(paths.workspace, 'plan.txt'), '계획')
    await writeFile(join(paths.privateDir, 'key.txt'), '비밀')
    for (const korean of [true, false]) {
      const asked: Record<string, string[]> = { app: [], plain: [] }
      for (const how of ['app', 'plain'] as const) {
        const read = kitFor(how, async (what) => { asked[how]!.push(what.words); return 'cancel' }, false, korean).files.find(tool => tool.name === 'file_read')!
        await expect(read.run({ path: outside }, { task: '장부 읽어줘' })).rejects.toThrow('File access was declined')
        const fresh = kitFor(how, async (what) => { asked[how]!.push(what.words); return 'cancel' }, false, korean).files.find(tool => tool.name === 'file_read')!
        expect(JSON.parse(await fresh.run({ path: join(paths.workspace, 'plan.txt') }, { task: '계획 읽어줘' })).content).toBe('계획')
        await expect(fresh.run({ path: join(paths.privateDir, 'key.txt') }, { task: '열쇠 읽어줘' })).rejects.toThrow('Private vault')
      }
      expect(asked['plain']).toEqual(asked['app'])
      expect(asked['plain']).toHaveLength(1)
      expect(asked['plain']![0]).toContain(outside)
    }
  })

  it('leaves a group empty when its inputs are not given', () => {
    const bare = toolKit({ paths, channel: 'lane-orchard', log: () => undefined, retrieve: async () => [], courier: null })
    expect({ team: bare.team, learning: bare.learning, files: bare.files, office: bare.office }).toEqual({ team: [], learning: [], files: [], office: [] })
    expect(bare.web.map(tool => tool.name)).toContain('search_memory')
    expect(bare.web.map(tool => tool.name)).not.toContain('open_page')
  })

  it('still returns the built file and its audit with no side-effect callbacks', async () => {
    const kit = kitFor('plain')
    const sheet = JSON.parse(await kit.files.find(tool => tool.name === 'file_create_workbook')!.run({ name: 'beds.xlsx', sheet: 'Beds', rows: [['bed', 'crop'], [1, 'kale']] }, { task: '화단표 만들어줘' })) as { path: string; completeReadback: boolean; taskPath: string }
    expect(sheet.completeReadback).toBe(true)
    expect((await readFile(sheet.taskPath)).length).toBeGreaterThan(0)
    const deck = await kit.office.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '가을 텃밭' }, { title: '심을 것', bullets: ['배추', '무'] }], theme: THEME }, { task: '발표 자료 만들어줘' })
    const built = JSON.parse(deck) as { markdownLink: string; slides: number; verification: string; taskPath: string }
    expect(built.slides).toBe(2)
    expect(built.markdownLink).toMatch(/\.pptx\]\(engram-artifact:/)
    expect(built.verification).toContain('2 slides')
    expect((await readFile(built.taskPath)).subarray(0, 2).toString()).toBe('PK')
    expect(deck).toContain('checked')
  })
})
