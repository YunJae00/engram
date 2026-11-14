import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { vaultPaths, type TurnStep, type VaultPaths } from 'core'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => `${state.home}/${name}` }, dialog: { showMessageBox: vi.fn() }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: {}, nativeImage: {}, BrowserWindow: class {}, session: {} }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
import { artifactDirectory, cometFileTools, OUTPUT_BYTES, placeInTask, resolveOutput, saveOutput, taskFile } from '../src/main/file-work.js'
import { cometNativeTools, deliverOutputs, mentionedOutputs, nativeDecision, rememberWorkFolder, workFolderFor, type NativePolicy } from '../src/main/native-tools.js'
import { checkResult, latestResultOutputs } from '../src/main/result-check.js'

let root: string, paths: VaultPaths
const quiet = { onStep: vi.fn(), audit: vi.fn() }
const context = { task: 'Make a file.' }
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/general-'))
  state.home = join(root, 'home')
  paths = vaultPaths(join(root, 'vault'))
  await Promise.all([paths.workspace, paths.privateDir, join(root, 'outside'), state.home].map(path => mkdir(path, { recursive: true })))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('gives each task its own folder under tasks/, kept out of the vault history', async () => {
  expect(await workFolderFor(paths, 'bot-x')).toBe(join(paths.workspace, 'tasks', 'bot-x'))
  const tools = await cometNativeTools({ paths, channel: 'bot-x', ...quiet })
  expect(tools.cwd).toBe(join(paths.workspace, 'tasks', 'bot-x'))
  expect(existsSync(tools.cwd)).toBe(true)
  expect(await readFile(join(paths.workspace, 'tasks', '.gitignore'), 'utf8')).toBe('*\n')
})

it('puts a hired member in a subfolder of the lead task folder', async () => {
  const lead = await cometNativeTools({ paths, channel: 'bot-x', ...quiet })
  await writeFile(join(lead.cwd, 'brief.md'), 'lead file')
  const member = await cometNativeTools({ paths, channel: 'bot-x:m1', member: 'bot-x:m1', cwd: lead.cwd, ...quiet })
  expect(member.cwd).toBe(join(lead.cwd, 'team', 'bot-x-m1'))
  expect(existsSync(member.cwd)).toBe(true)
  expect((await member.decide('Write', { file_path: 'part.md', content: '' })).behavior).toBe('allow')
  expect((await member.decide('Write', { file_path: join(lead.cwd, 'brief.md'), content: '' })).behavior).toBe('deny')
  expect((await member.decide('Read', { file_path: join(lead.cwd, 'brief.md') })).behavior).toBe('allow')
  expect((await lead.decide('Read', { file_path: join(member.cwd, 'part.md') })).behavior).toBe('allow')
})

it.skipIf(process.platform === 'win32')('refuses folders and files that redirect outside through a link', async () => {
  await mkdir(join(paths.workspace, 'tasks'), { recursive: true })
  await symlink(join(root, 'outside'), join(paths.workspace, 'tasks', 'bot-evil'))
  await expect(cometNativeTools({ paths, channel: 'bot-evil', ...quiet })).rejects.toThrow('cannot redirect outside')
  const lead = await cometNativeTools({ paths, channel: 'bot-y', ...quiet })
  await symlink(join(root, 'outside'), join(lead.cwd, 'team'))
  await expect(cometNativeTools({ paths, channel: 'm', member: 'm', cwd: lead.cwd, ...quiet })).rejects.toThrow('member folder must stay inside')
  await writeFile(join(root, 'outside', 'key.txt'), 'secret')
  await symlink(join(root, 'outside', 'key.txt'), join(lead.cwd, 'key.txt'))
  await expect(taskFile(paths, lead.cwd, 'key.txt')).rejects.toThrow('inside the task folder')
  await expect(taskFile(paths, lead.cwd, join(root, 'outside', 'key.txt'))).rejects.toThrow('inside the task folder')
  expect(await mentionedOutputs(lead.cwd, 'See key.txt', 0)).toEqual([])
})

it('keeps folders from before tasks/ existed and clears only empty unowned spares', async () => {
  await rememberWorkFolder(paths, 'bot-old', join(paths.cache, 'work', 'spare-1'))
  expect(await workFolderFor(paths, 'bot-old')).toBe(join(paths.cache, 'work', 'spare-1'))
  await mkdir(join(paths.cache, 'work', 'bot-kept'), { recursive: true })
  expect(await workFolderFor(paths, 'bot-kept')).toBe(join(paths.cache, 'work', 'bot-kept'))
  const tasks = join(paths.workspace, 'tasks')
  await Promise.all(['spare-empty', 'spare-full', 'spare-owned'].map(name => mkdir(join(tasks, name), { recursive: true })))
  await writeFile(join(tasks, 'spare-full', 'a.txt'), 'x')
  await rememberWorkFolder(paths, 'bot-owner', join(tasks, 'spare-owned'))
  await cometNativeTools({ paths, channel: 'spare-new', cwd: join(tasks, 'spare-new'), ...quiet })
  expect((await readdir(tasks)).filter(name => name.startsWith('spare-')).sort()).toEqual(['spare-full', 'spare-new', 'spare-owned'])
})

it('detects pdf, png, xlsx, csv and script outputs named in the answer, within the size cap', async () => {
  const cwd = join(root, 'task')
  await mkdir(cwd)
  const since = Date.now() - 1000
  for (const name of ['a.pdf', 'a.png', 'a.xlsx', 'a.csv', 'a.py', 'a.exe', 'old.pdf', 'linked.pdf', 'big.zip', '.hidden.md']) await writeFile(join(cwd, name), 'x')
  await utimes(join(cwd, 'old.pdf'), new Date(since - 60_000), new Date(since - 60_000))
  await truncate(join(cwd, 'big.zip'), OUTPUT_BYTES + 1)
  const oversized: string[] = []
  const found = await mentionedOutputs(cwd, 'a.pdf a.png a.xlsx a.csv a.py a.exe old.pdf big.zip .hidden.md [linked.pdf](engram-artifact:abc-linked.pdf)', since, oversized)
  expect(found.map(path => basename(path)).sort()).toEqual(['a.csv', 'a.pdf', 'a.png', 'a.py', 'a.xlsx'])
  expect(oversized).toEqual(['big.zip'])
})

it('saves outputs once per content, under the cap, and resolves only plain supported ids', async () => {
  const directory = artifactDirectory(paths)
  await expect(saveOutput(directory, 'big.zip', Buffer.alloc(OUTPUT_BYTES + 1))).rejects.toThrow('exceeds 50 MB')
  await expect(saveOutput(directory, 'fake.pdf', Buffer.from('nope'))).rejects.toThrow('not a PDF')
  await expect(saveOutput(directory, 'run.exe', Buffer.from('x'))).rejects.toThrow('supported extension')
  const first = await saveOutput(directory, 'run.py', Buffer.from('print(1)\n'))
  const again = await saveOutput(directory, 'run.py', Buffer.from('print(1)\n'))
  expect(again.artifact).toBe(first.artifact)
  expect(await readdir(directory)).toEqual([first.artifact])
  expect(await resolveOutput(directory, first.artifact)).toBe(first.path)
  await expect(resolveOutput(directory, '../x.py')).rejects.toThrow('Invalid artifact')
  await expect(resolveOutput(directory, first.artifact.replace(/\.py$/, '.exe'))).rejects.toThrow('Invalid artifact')
})

it('never overwrites a file in the task folder', async () => {
  const cwd = join(root, 'task')
  await mkdir(cwd)
  const first = await placeInTask(cwd, 'report.pdf', Buffer.from('one'))
  expect(await placeInTask(cwd, 'report.pdf', Buffer.from('one'))).toBe(first)
  const second = await placeInTask(cwd, 'report.pdf', Buffer.from('two'))
  expect(basename(second)).toBe('report (2).pdf')
  expect(await readFile(first, 'utf8')).toBe('one')
  expect((await readdir(cwd)).sort()).toEqual(['report (2).pdf', 'report.pdf'])
})

it('saves scripts and workbooks as linked outputs with a copy in the task folder', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  expect(tools.map(tool => tool.name)).toContain('render_file')
  const copy = tools.find(tool => tool.name === 'file_create_copy')!
  const script = JSON.parse(await copy.run({ name: 'rename.py', content: 'import os\n' }, context))
  expect(script.markdownLink).toContain('engram-artifact:')
  expect(await readFile(script.path, 'utf8')).toBe('import os\n')
  expect(await readFile(join(cwd, 'rename.py'), 'utf8')).toBe('import os\n')
  await writeFile(join(root, 'outside', 'x.py'), 'x')
  await expect(copy.run({ name: 'x.py', fromPath: join(root, 'outside', 'x.py') }, context)).rejects.toThrow('inside the task folder')
  await expect(copy.run({ name: 'x.pdf', content: '%PDF-' }, context)).rejects.toThrow('fromPath')
  const book = JSON.parse(await tools.find(tool => tool.name === 'file_create_workbook')!.run({ name: 'spend.xlsx', sheet: 'Spend', rows: [['Item', 'Cost'], ['Rent', 100]] }, context))
  expect((await readFile(book.taskPath)).subarray(0, 2).toString()).toBe('PK')
  const csv = JSON.parse(await copy.run({ name: 'spend.csv', content: 'Item,Cost\nRent,100\n' }, context))
  expect(await readFile(csv.taskPath, 'utf8')).toBe('Item,Cost\nRent,100\n')
})

it('adds a card for every saved output, and hands in raw files only from a finished turn', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  const args = { name: 'spend.xlsx', sheet: 'Spend', rows: [['Cost'], [1]] }
  const observation = await tools.find(tool => tool.name === 'file_create_workbook')!.run(args, context)
  const steps: TurnStep[] = [{ tool: 'file_create_workbook', args, observation }]
  const cut = { answer: 'Made it.', steps: [...steps], stopped: 'repetition' }
  await writeFile(join(cwd, 'plot.py'), 'print(1)\n')
  cut.answer = 'Made it and plot.py.'
  await deliverOutputs(paths, cwd, cut, 0, 'ask')
  expect(cut.answer).toMatch(/\[spend\.xlsx\]\(engram-artifact:[^)]+spend\.xlsx\)/)
  expect(cut.answer).not.toContain('plot.py]')
  expect(cut.steps).toHaveLength(1)
  const done = { answer: 'Made it and plot.py.', steps: [...steps] }
  await deliverOutputs(paths, cwd, done, 0, 'ask')
  expect(done.answer).toMatch(/\[plot\.py\]\(engram-artifact:[^)]+plot\.py\)/)
  expect(done.steps).toHaveLength(2)
  const asked = { answer: 'Which month? plot.py', steps: [...steps], asked: true }
  await deliverOutputs(paths, cwd, asked, 0, 'ask')
  expect(asked.answer).toBe('Which month? plot.py')
})

it('keeps the write, command and web gates', async () => {
  const cwd = join(root, 'task')
  await mkdir(cwd)
  const ask = vi.fn(async () => 'approve' as const)
  const policy = (extra: Partial<NativePolicy>): NativePolicy => ({ cwd, roots: [cwd], privateDir: paths.privateDir, commands: { allowed: false }, ask, ...extra })
  const outside = await nativeDecision(policy({}), 'Write', { file_path: '../outside.txt', content: '' })
  expect(outside.behavior).toBe('deny')
  expect(outside.message).toContain('render_file')
  expect((await nativeDecision(policy({ sandboxed: true, mode: 'auto' }), 'Bash', { command: 'python3 rename.py' })).behavior).toBe('allow')
  expect(ask).not.toHaveBeenCalled()
  await nativeDecision(policy({ sandboxed: false, mode: 'auto' }), 'Bash', { command: 'ls' })
  expect(ask).toHaveBeenCalledTimes(1)
  await nativeDecision(policy({ sandboxed: true, mode: 'auto' }), 'Bash', { command: 'curl x', dangerouslyDisableSandbox: true })
  expect(ask).toHaveBeenCalledTimes(2)
  const web = await nativeDecision(policy({}), 'WebFetch', { url: 'https://example.com' })
  expect(web).toEqual({ behavior: 'deny', message: 'Use Engram\'s web tools so its connection and approval checks still apply.' })
})

it('counts a rendered file as a result output that needs no text reread', () => {
  const receipt = JSON.stringify({ path: '/a/id-report.pdf', sha256: 'a'.repeat(64), completeReadback: true })
  const render: TurnStep = { tool: 'render_file', args: { name: 'report.pdf', html: '<p>x</p>' }, observation: receipt }
  const outputs = latestResultOutputs([render], [])
  expect(outputs.map(output => output.name)).toEqual(['report.pdf'])
  const report: TurnStep = { tool: 'report_result_check', args: {}, observation: '{}' }
  expect(checkResult([render, report], outputs, []).issues.join(' ')).not.toMatch(/report\.pdf/)
  expect(checkResult([render, report, render], outputs, []).issues.join(' ')).toContain('The result changed after report_result_check')
})

it.skipIf(process.platform === 'win32')('writes nothing through a tasks folder that links outside the workspace', async () => {
  await symlink(join(root, 'outside'), join(paths.workspace, 'tasks'))
  await expect(cometNativeTools({ paths, channel: 'bot-z', ...quiet })).rejects.toThrow('cannot redirect outside')
  expect(await readdir(join(root, 'outside'))).toEqual([])
})

it('hands in a revised task file again and points the answer at the new copy', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const draft = JSON.parse(await copy.run({ name: 'report.py', content: 'print(1)\n' }, context))
  const answer = `Here it is: ${draft.markdownLink}`
  const same = { answer, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, same, 0, 'ask')
  expect(same.answer).toBe(answer)
  await writeFile(join(cwd, 'report.py'), 'print(2)\n')
  const revised = { answer, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps).toHaveLength(1)
  expect(revised.answer).not.toContain(draft.markdownLink)
  const id = /\(engram-artifact:([^)]+)\)/.exec(revised.answer)![1]!
  expect(await readFile(join(artifactDirectory(paths), decodeURIComponent(id)), 'utf8')).toBe('print(2)\n')
})
