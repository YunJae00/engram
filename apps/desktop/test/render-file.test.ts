import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vaultPaths, type VaultPaths } from 'core'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
type Filter = (details: { url: string }, done: (response: { cancel: boolean }) => void) => void
const fake = vi.hoisted(() => ({ windows: [] as { options: Record<string, unknown>; destroyed: number; loaded: string }[], filters: [] as unknown[], proxies: [] as unknown[], hang: false, events: [] as string[], pdf: 0 }))
vi.mock('electron', async () => {
  const { readFile: read } = await import('node:fs/promises')
  return {
    app: { getPath: () => '/nowhere' }, dialog: {}, ipcMain: { removeHandler: () => undefined, handle: () => undefined }, shell: {}, nativeImage: {},
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest: (filter: unknown) => { fake.filters.push(filter) } }, setProxy: async (rules: unknown) => { fake.proxies.push(rules) }, setPermissionRequestHandler: () => undefined, on: () => undefined }) },
    BrowserWindow: class {
      record = { options: {} as Record<string, unknown>, destroyed: 0, loaded: '' }
      constructor(options: Record<string, unknown>) { this.record.options = options; fake.windows.push(this.record); fake.events.push('open') }
      loadFile = async (file: string) => { if (fake.hang) await new Promise(() => undefined); this.record.loaded = await read(file, 'utf8') }
      destroy = () => { this.record.destroyed += 1; fake.events.push('close') }
      webContents = {
        setWindowOpenHandler: () => undefined, on: () => undefined, setWebRTCIPHandlingPolicy: () => undefined, setAudioMuted: () => undefined,
        insertCSS: async () => '', executeJavaScript: async () => undefined,
        printToPDF: async () => Buffer.from(`%PDF-1.7\nrender ${fake.pdf += 1}`),
        capturePage: async () => ({ isEmpty: () => false, resize: () => ({ toPNG: () => PNG }), toPNG: () => PNG }),
      }
    },
  }
})
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
import { cometFileTools } from '../src/main/file-work.js'
import { requestAllowed } from '../src/main/render-file.js'

let root: string, paths: VaultPaths, cwd: string
const render = () => cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'render_file')!
const context = { task: 'Make a PDF.' }
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/render-'))
  paths = vaultPaths(join(root, 'vault'))
  cwd = join(paths.workspace, 'tasks', 'bot-x')
  await Promise.all([cwd, paths.privateDir, join(root, 'outside')].map(path => mkdir(path, { recursive: true })))
  Object.assign(fake, { windows: [], filters: [], proxies: [], hang: false, events: [], pdf: 0 })
})
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

it('renders inline HTML to a real PDF in the task folder through a hidden, locked-down window', async () => {
  const receipt = JSON.parse(await render().run({ name: '서울 날씨.pdf', html: '<h1>서울 날씨</h1>' }, context))
  expect((await readFile(join(cwd, '서울 날씨.pdf'))).subarray(0, 4).toString()).toBe('%PDF')
  expect((await readFile(receipt.path)).subarray(0, 4).toString()).toBe('%PDF')
  expect(receipt.markdownLink).toContain('engram-artifact:')
  expect(receipt.taskPath).toBe(join(await realpath(cwd), '서울 날씨.pdf'))
  expect(fake.windows[0]!.options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  expect(fake.windows[0]!.loaded).toContain('서울 날씨')
  expect(fake.windows[0]!.destroyed).toBe(1)
  expect(fake.proxies).toHaveLength(1)
})

it('renders Markdown to a PNG at the requested size and leaves no temporary page', async () => {
  const receipt = JSON.parse(await render().run({ name: 'chart.png', markdown: '# 월별 매출\n\n| 월 | 매출 |\n| - | - |\n| 1 | 10 |', width: 800, height: 500 }, context))
  expect((await readFile(receipt.taskPath)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(fake.windows[0]!.options).toMatchObject({ width: 800, height: 500 })
  expect(fake.windows[0]!.loaded).toContain('<table>')
  expect((await readdir(cwd)).sort()).toEqual(['chart.md', 'chart.png'])
})

it.skipIf(process.platform === 'win32')('blocks every request except real files inside the task folder', async () => {
  await render().run({ name: 'a.pdf', html: '<p>x</p>' }, context)
  const folder = await realpath(cwd)
  const cancelled = (url: string) => { let out = false; (fake.filters[0] as Filter)({ url }, response => { out = response.cancel }); return out }
  await writeFile(join(root, 'outside', 'secret.txt'), 'secret')
  await symlink(join(root, 'outside', 'secret.txt'), join(cwd, 'link.txt'))
  expect(cancelled('https://example.com/a.js')).toBe(true)
  expect(cancelled('ws://example.com/socket')).toBe(true)
  expect(cancelled('file:///etc/hosts')).toBe(true)
  expect(cancelled(pathToFileURL(join(cwd, 'link.txt')).href)).toBe(true)
  expect(cancelled(pathToFileURL(join(folder, 'a.html')).href)).toBe(false)
  expect(requestAllowed(folder, 'data:text/html,x')).toBe(false)
})

it.skipIf(process.platform === 'win32')('refuses sources outside the task folder before any window opens', async () => {
  await writeFile(join(root, 'outside', 'x.html'), '<p>x</p>')
  await symlink(join(root, 'outside', 'x.html'), join(cwd, 'linked.html'))
  for (const source of ['../../notes/x.html', join(root, 'outside', 'x.html'), 'linked.html']) {
    await expect(render().run({ name: 'x.pdf', source }, context)).rejects.toThrow('inside the task folder')
  }
  await expect(render().run({ name: 'x.docx', html: '<p>x</p>' }, context)).rejects.toThrow('.pdf or .png')
  await expect(render().run({ name: 'x.pdf', html: '<p>x</p>', markdown: 'x' }, context)).rejects.toThrow('exactly one')
  expect(fake.windows).toHaveLength(0)
})

it('gives up after 20 seconds or on cancel, and closes the window', async () => {
  fake.hang = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const slow = expect(render().run({ name: 'slow.pdf', html: '<p>x</p>' }, context)).rejects.toThrow('longer than 20 seconds')
  while (fake.windows.length === 0) await new Promise(resolve => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(20_100)
  await slow
  vi.useRealTimers()
  const abort = new AbortController()
  const cancelled = expect(render().run({ name: 'stop.pdf', html: '<p>x</p>' }, { ...context, signal: abort.signal })).rejects.toThrow('canceled')
  await vi.waitFor(() => expect(fake.windows).toHaveLength(2))
  abort.abort()
  await cancelled
  expect(fake.windows.map(window => window.destroyed)).toEqual([1, 1])
  expect(existsSync(join(cwd, 'slow.pdf')) || existsSync(join(cwd, 'stop.pdf'))).toBe(false)
})

it('renders one page at a time and never overwrites an earlier output', async () => {
  const [first, second] = (await Promise.all([render().run({ name: 'a.pdf', html: '<p>one</p>' }, context), render().run({ name: 'a.pdf', html: '<p>two</p>' }, context)])).map(text => JSON.parse(text))
  expect(fake.events).toEqual(['open', 'close', 'open', 'close'])
  // Both saved outputs stay, each with its own render; the task folder keeps one a.pdf, the later one, with no "a (2).pdf" beside it (QA 0.8.145 S03/S33).
  expect(first.taskPath).toBe(second.taskPath)
  expect(first.taskPath).toMatch(/[\\/]a\.pdf$/)
  expect(existsSync(join(cwd, 'a (2).pdf'))).toBe(false)
  expect(await readFile(join(cwd, 'a.pdf'), 'utf8')).toMatch(/render [12]$/)
  expect(first.path).not.toBe(second.path)
  expect(await readFile(first.path, 'utf8')).not.toBe(await readFile(second.path, 'utf8'))
})

it('keeps an existing source of the same name and renders from a numbered twin', async () => {
  await writeFile(join(cwd, 'report.html'), '<p>mine</p>')
  await writeFile(join(cwd, 'report.md'), '# mine')
  await render().run({ name: 'report.pdf', html: '<p>new</p>' }, context)
  await render().run({ name: 'report.png', markdown: '# new' }, context)
  expect(await readFile(join(cwd, 'report.html'), 'utf8')).toBe('<p>mine</p>')
  expect(await readFile(join(cwd, 'report.md'), 'utf8')).toBe('# mine')
  expect(await readFile(join(cwd, 'report (2).html'), 'utf8')).toBe('<p>new</p>')
  expect(await readFile(join(cwd, 'report (2).md'), 'utf8')).toBe('# new')
})
