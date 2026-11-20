import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { CHECK_SCRATCH, continuationPrompt, vaultPaths, type DelegatedTask, type FileCard, type TurnStep, type VaultPaths } from 'core'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => `${state.home}/${name}` }, dialog: { showMessageBox: vi.fn() }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: {}, nativeImage: {}, BrowserWindow: class {}, session: {} }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
import { artifactDirectory, checkedOutputs, cometFileTools, linkedOutputs, OUTPUT_BYTES, placeInTask, resolveOutput, saveOutput, taskFile, twinsFile } from '../src/main/file-work.js'
import { cometNativeTools, deliverOutputs, mentionedOutputs, nativeDecision, rememberWorkFolder, withFiles, workFolderFor, type NativePolicy } from '../src/main/native-tools.js'
import { checkResult, latestResultOutputs } from '../src/main/result-check.js'
import { freshResultReadback } from '../src/main/task-result-state.js'

let root: string, paths: VaultPaths
const quiet = { onStep: vi.fn(), audit: vi.fn() }
const context = { task: 'Make a file.' }
type Shown = { answer: string; files?: FileCard[] }
const cards = (result: Shown): FileCard[] => result.files ?? []
const shown = (result: Shown): string => withFiles(result.answer, cards(result))
const saved = (card: FileCard): Promise<string> => readFile(join(artifactDirectory(paths), decodeURIComponent(card.href)), 'utf8')
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
  expect(cut.answer).toBe('Made it and plot.py.')
  expect(cards(cut)).toEqual([{ name: 'spend.xlsx', href: expect.stringMatching(/spend\.xlsx$/) }])
  expect(cut.steps).toHaveLength(1)
  const done = { answer: 'Made it and plot.py.', steps: [...steps] }
  await deliverOutputs(paths, cwd, done, 0, 'ask')
  expect(done.answer).toBe('Made it and plot.py.')
  expect(cards(done)).toEqual([{ name: 'spend.xlsx', href: cards(cut)[0]!.href }, { name: 'plot.py', href: expect.stringMatching(/plot\.py$/) }])
  expect(done.steps).toHaveLength(2)
  const asked = { answer: 'Which month? plot.py', steps: [...steps], asked: true }
  await deliverOutputs(paths, cwd, asked, 0, 'ask')
  expect(asked.answer).toBe('Which month? plot.py')
  expect(asked).not.toHaveProperty('files')
  expect(asked.steps).toHaveLength(1)
})

it('does not hand over a file this turn made and then edited', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const made = async (tool: string, args: Record<string, unknown>, bytes: string, taskPath?: string): Promise<TurnStep> => ({ tool, args, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'spend.xlsx', Buffer.from(bytes)), completeReadback: true, ...(taskPath ? { taskPath } : {}) }) })
  const book = await made('file_create_workbook', { name: 'spend.xlsx', sheet: 'Spend', rows: [['Cost'], [1]] }, 'PK-first', join(cwd, 'spend.xlsx'))
  const edit = await made('file_edit_package', { name: 'spend.xlsx', sourcePath: join(cwd, 'spend.xlsx'), edits: [] }, 'PK-fixed')
  const link = (JSON.parse(edit.observation) as { markdownLink: string }).markdownLink
  const result = { answer: `고쳤어요. ${link}`, steps: [book, edit] }
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe(`고쳤어요. ${link}`)
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
  const made: TurnStep = { tool: 'file_create_copy', args: { name: 'report.py', content: 'print(1)\n' }, observation: JSON.stringify(draft) }
  const same = { answer, steps: [made] }
  await deliverOutputs(paths, cwd, same, 0, 'ask')
  expect(same.answer).toBe(answer)
  expect(cards(same)).toEqual([])
  expect(same.steps).toEqual([made])
  await writeFile(join(cwd, 'report.py'), 'print(2)\n')
  const revised = { answer, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps).toHaveLength(1)
  expect(revised.answer).toBe(answer)
  expect(cards(revised).map(card => card.name)).toEqual(['report.py'])
  expect(draft.markdownLink).not.toContain(cards(revised)[0]!.href)
  expect(await saved(cards(revised)[0]!)).toBe('print(2)\n')
  await truncate(join(cwd, 'report.py'), OUTPUT_BYTES + 1)
  const huge = { answer, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, huge, 0, 'ask')
  expect(huge.answer).toBe(answer)
  expect(cards(huge)).toEqual([])
  expect(huge.steps).toEqual([])
})

const passed = (requirement: string): TurnStep => ({ tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ status: 'pass', basis: 'Compared.', requirement }], grounding: { status: 'pass', basis: 'Compared.' } } }) })
const judged = async (result: Shown & { steps: TurnStep[] }) => {
  const outputs = latestResultOutputs(result.steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: shown(result) }]))
  return { outputs: outputs.map(output => output.name).sort(), check: checkResult(result.steps, outputs, []) }
}

it('a check turn whose checks passed stays verified when its comparison script is handed in from the task folder', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  const first = JSON.parse(await tools.find(tool => tool.name === 'file_create_copy')!.run({ name: 'merged.md', content: '# merged\n' }, context)) as { markdownLink: string; path: string }
  const link = first.markdownLink, artifact = first.path
  const read: TurnStep = { tool: 'file_read', args: { path: artifact }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: artifact }, context) }
  await writeFile(join(cwd, 'check_merge.py'), 'print(0)\n')
  const ran: TurnStep = { tool: 'Bash', args: { command: 'python3 check_merge.py' }, observation: '0 mismatches' }
  const made: TurnStep = { tool: 'Bash', args: { command: "printf 'print(0)\\n' > check_merge.py" }, observation: '' }
  const byCommand = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, made, ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, byCommand, 0, 'ask')
  expect(byCommand.answer).toBe(`Compared with check_merge.py: 0 mismatches.\n\n${link}`)
  expect(cards(byCommand).map(card => card.name)).toEqual(['check_merge.py'])
  const linked = shown(byCommand)
  expect(byCommand.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'check_merge.py' } })
  const before = await judged(byCommand)
  expect(before.outputs).toEqual(['check_merge.py', 'merged.md'])
  const handedIn = JSON.parse(byCommand.steps.at(-1)!.observation).path as string
  expect(before.check).toMatchObject({ accepted: false, verified: false, readbacks: [{ name: 'check_merge.py', path: handedIn }] })
  expect(before.check.issues).toHaveLength(1)
  expect(before.check.issues[0]).toContain('Reread every final part of check_merge.py')
  const later = cometFileTools(paths, 'bot-x', (await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: linked }])).map(output => output.path), [cwd])
  const reopen = async (path: string): Promise<TurnStep> => ({ tool: 'file_read', args: { path }, observation: await later.find(tool => tool.name === 'file_read')!.run({ path }, context) })
  const followUp = { answer: linked, steps: [await reopen(artifact), await reopen(handedIn), passed('Leads merged')] }
  await deliverOutputs(paths, cwd, followUp, Date.now() + 60_000, 'ask')
  expect(followUp.steps).toHaveLength(3)
  expect(followUp.answer).toBe(linked)
  expect(cards(followUp)).toEqual([])
  const second = await judged(followUp)
  expect(second.outputs).toEqual(['check_merge.py', 'merged.md'])
  expect(second.check).toEqual({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(followUp.steps)).toBe(true)
  const both: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: ['Leads merged', 'No duplicate leads'].map(requirement => ({ status: 'pass', basis: 'Compared.', requirement })), grounding: { status: 'pass', basis: 'Compared.' } } }) }
  const held = async (report: TurnStep, reads = [artifact, handedIn]) => {
    const steps = [...await Promise.all(reads.map(reopen)), report]
    return checkResult(steps, latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: linked }])), [], false)
  }
  const dropped = await held(passed('Leads merged'))
  expect(dropped).toEqual({ accepted: true, verified: true, issues: [] })
  expect(dropped.issues.join(' ')).not.toContain('leaves out a requirement check')
  const oneRead = await held(passed('Leads merged'), [artifact])
  expect(oneRead).toMatchObject({ accepted: false, verified: false })
  expect(oneRead.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  const failing: TurnStep = { ...both, observation: both.observation.replace('"status":"pass","basis":"Compared.","requirement":"No duplicate leads"', '"status":"unknown","basis":"Not compared.","requirement":"No duplicate leads"') }
  expect(await held(failing)).toMatchObject({ verified: false, issues: ['No duplicate leads: unknown — Not compared.'] })
  expect(await held(both)).toEqual({ accepted: true, verified: true, issues: [] })
  expect((await judged({ answer: linked, steps: [await reopen(artifact), passed('Leads merged')] })).check.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  const wrote: TurnStep = { tool: 'Write', args: { file_path: join(cwd, 'check_merge.py'), content: 'print(0)\n' }, observation: 'Native action completed.' }
  const checked = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, wrote, ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, checked, 0, 'ask')
  expect(checked.answer).toBe(`Compared with check_merge.py: 0 mismatches.\n\n${link}`)
  expect(cards(checked).map(card => card.name)).toEqual(['check_merge.py'])
  expect(checked.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'check_merge.py' } })
  const { outputs, check } = await judged(checked)
  expect(outputs).toEqual(['check_merge.py', 'merged.md'])
  expect(check).toMatchObject({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(checked.steps)).toBe(false)
  expect(freshResultReadback([wrote, ran, read, ...checked.steps.slice(3)])).toBe(true)
  const unmarked = checked.steps.map(step => step.tool === 'file_create_copy' ? { ...step, observation: JSON.stringify({ ...JSON.parse(step.observation), handedInFrom: undefined }) } : step)
  expect(checkResult(unmarked, latestResultOutputs(unmarked, []), []).issues.join(' ')).toContain('The result changed after report_result_check')
  expect(freshResultReadback(unmarked)).toBe(false)
  await writeFile(join(cwd, 'check_merge.py'), 'print(1)\n')
  const patched: TurnStep = { tool: 'Bash', args: { command: 'sed -i s/0/1/ check_merge.py && cat check_merge.py' }, observation: 'print(1)\n' }
  const changed = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, wrote, patched, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, changed, 0, 'ask')
  const drifted = (await judged(changed)).check
  expect(drifted).toMatchObject({ accepted: false, verified: false })
  expect(drifted.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  const reread: TurnStep = { tool: 'file_read', args: { path: join(cwd, 'check_merge.py') }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: join(cwd, 'check_merge.py') }, context) }
  const seen = { answer: changed.answer, steps: [read, wrote, patched, reread, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, seen, 0, 'ask')
  expect((await judged(seen)).check).toMatchObject({ accepted: true, verified: true, issues: [] })
  await writeFile(join(cwd, 'check_merge.py'), 'print(0)\n')
  const unread = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, unread, 0, 'ask')
  expect((await judged(unread)).check.issues.join(' ')).toContain('Reread every final part of merged.md')
})

it('a re-check that links no file still answers for the files of the report it re-checks', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  const make = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const report = JSON.parse(await make.run({ name: 'report.md', content: '# report\n' }, context)) as { markdownLink: string; path: string }
  const notes = JSON.parse(await make.run({ name: 'notes.md', content: '# notes\n' }, context)) as { path: string }
  const tools = cometFileTools(paths, 'bot-x', [report.path, notes.path], [cwd])
  const reopen = async (path: string): Promise<TurnStep> => ({ tool: 'file_read', args: { path }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path }, context) })
  const earlier = `Merged the leads. ${report.markdownLink}`, budgetNote = 'The task token budget was reached. Work so far is preserved.'
  const recheck = async (steps: TurnStep[], answer = budgetNote) => checkResult(steps, latestResultOutputs(steps, await checkedOutputs(artifactDirectory(paths), answer, earlier, answer.startsWith(budgetNote))), [])
  const unrelated = [await reopen(notes.path), passed('Leads merged')]
  expect(freshResultReadback(unrelated)).toBe(true)
  expect(await recheck(unrelated)).toMatchObject({ accepted: false, verified: false, issues: [expect.stringContaining(`Reread every final part of report.md (${report.path})`)] })
  expect(await recheck(unrelated, 'Checked again; nothing to correct.')).toMatchObject({ accepted: false, issues: [expect.stringContaining('Reread every final part of report.md')] })
  expect(await recheck([passed('Leads merged')])).toMatchObject({ accepted: false })
  expect(await recheck([await reopen(report.path), passed('Leads merged')])).toEqual({ accepted: true, verified: true, issues: [] })
  expect(await checkedOutputs(artifactDirectory(paths), budgetNote)).toEqual([])
  expect(await checkedOutputs(artifactDirectory(paths), earlier)).toEqual([{ name: 'report.md', path: report.path }])
  const made = async (content: string): Promise<{ step: TurnStep; path: string; link: string }> => { const observation = await tools.find(tool => tool.name === 'file_create_copy')!.run({ name: 'report.md', content }, context), saved = JSON.parse(observation) as { path: string; markdownLink: string }; return { step: { tool: 'file_create_copy', args: { name: 'report.md', content }, observation }, path: saved.path, link: saved.markdownLink } }
  const newer = await made('# another report\n')
  expect(newer.path).not.toBe(report.path)
  const sameName = [newer.step, await reopen(newer.path), passed('Leads merged')]
  expect(freshResultReadback(sameName)).toBe(true)
  for (const answer of [budgetNote, `${budgetNote}\n\n${newer.link}`]) {
    expect(await recheck(sameName, answer)).toMatchObject({ accepted: false, verified: false, issues: [expect.stringContaining(`Reread every final part of report.md (${report.path})`)] })
    expect(latestResultOutputs(sameName, await checkedOutputs(artifactDirectory(paths), answer, earlier, true)).map(output => output.path)).toEqual([report.path, newer.path])
  }
  const again = await made('# report\n'), third = await made('# third\n')
  expect(again.path).toBe(report.path)
  expect((await recheck([again.step, third.step, await reopen(third.path), passed('Leads merged')])).issues.join(' ')).toContain(`Reread every final part of report.md (${report.path})`)
  expect(await recheck([await reopen(report.path), again.step, passed('Leads merged')])).toMatchObject({ accepted: false })
  expect(await recheck([newer.step, await reopen(newer.path), await reopen(report.path), passed('Leads merged')], `${budgetNote}\n\n${newer.link}`)).toEqual({ accepted: true, verified: true, issues: [] })
  expect(await checkedOutputs(artifactDirectory(paths), `Corrected. ${newer.link}`, earlier)).toEqual([{ name: 'report.md', path: newer.path }])
  const both = `Merged the leads. ${report.markdownLink} ${newer.link}`
  const normal = async (steps: TurnStep[], answer: string) => checkResult(steps, latestResultOutputs(steps, await checkedOutputs(artifactDirectory(paths), answer, both)), [])
  expect((await checkedOutputs(artifactDirectory(paths), `Checked. ${newer.link}`, both)).map(output => output.path)).toEqual([report.path, newer.path])
  expect(await normal([await reopen(newer.path), passed('Leads merged')], `Checked. ${newer.link}`)).toMatchObject({ accepted: false, verified: false, issues: [expect.stringContaining(`Reread every final part of report.md (${report.path})`)] })
  expect((await checkedOutputs(artifactDirectory(paths), `Corrected. ${third.link}`, both)).map(output => output.path)).toEqual([report.path, newer.path, third.path])
  expect((await normal([third.step, await reopen(third.path), passed('Leads merged')], `Corrected. ${third.link}`)).issues.join(' ')).toContain(`Reread every final part of report.md (${report.path})`)
  expect(await normal([await reopen(report.path), await reopen(newer.path), passed('Leads merged')], `Checked. ${newer.link}`)).toEqual({ accepted: true, verified: true, issues: [] })
})

it('scratch in the check folder the answer does not name stays out, and a file there the answer names is handed in and checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, CHECK_SCRATCH, 'deep'), { recursive: true })
  await writeFile(join(cwd, 'merged.md'), '# merged\n')
  const first = { answer: 'Saved merged.md.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  expect(first.answer).toBe('Saved merged.md.')
  expect(cards(first).map(card => card.name)).toEqual(['merged.md'])
  const link = withFiles('', cards(first)).trim()
  for (const name of ['check_merge.py', 'diff.md', join('deep', 'counts.csv')]) await writeFile(join(cwd, CHECK_SCRATCH, name), 'x\n')
  const ran: TurnStep = { tool: 'Bash', args: { command: `python3 ${CHECK_SCRATCH}/check_merge.py` }, observation: '0 mismatches' }
  const steps = [ran, passed('Leads merged')]
  const checked = { answer: `Compared the merged file with the sources: 0 mismatches.\n\n${link}`, steps: [...steps] }
  await deliverOutputs(paths, cwd, checked, 0, 'ask')
  expect(checked.steps).toEqual(steps)
  expect(checked.answer).toBe(`Compared the merged file with the sources: 0 mismatches.\n\n${link}`)
  expect(cards(checked)).toEqual([])
  expect((await judged(checked)).outputs).toEqual(['merged.md'])
  expect(await mentionedOutputs(cwd, checked.answer, 0, [], artifactDirectory(paths), { 'merged.md': 'merged.md' })).toEqual([])
  const prompt = continuationPrompt({ goal: 'Merge the leads.', result: 'Saved merged.md.' } as DelegatedTask, 'verify')
  expect(prompt).toContain(`inside the ${CHECK_SCRATCH}/ folder`)
  expect(prompt).toContain('only when your answer names it')
  await writeFile(join(cwd, CHECK_SCRATCH, 'report.md'), '# audit\n')
  const named = { answer: `Wrote ${CHECK_SCRATCH}/report.md.\n\n${link}`, steps: [passed('Report written')] }
  await deliverOutputs(paths, cwd, named, 0, 'ask')
  expect(named.answer).toBe(`Wrote ${CHECK_SCRATCH}/report.md.\n\n${link}`)
  expect(cards(named).map(card => card.name)).toEqual(['report.md'])
  expect(named.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'report.md' } })
  const { outputs, check } = await judged(named)
  expect(outputs).toEqual(['merged.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
})

it('two named files with the same name in different folders are both handed in, linked and checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  for (const folder of ['one', 'two']) {
    await mkdir(join(cwd, folder), { recursive: true })
    await writeFile(join(cwd, folder, 'report.md'), `# ${folder}\n`)
  }
  const result = { answer: 'Wrote one/report.md and two/report.md.', steps: [passed('Reports written')] }
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe('Wrote one/report.md and two/report.md.')
  expect(cards(result).map(card => card.name)).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(cards(result).map(saved))).toEqual(['# one\n', '# two\n'])
  const { outputs, check } = await judged(result)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
})

it('a hand-in is known by its source path: same-name files with the same bytes each keep their own name and link across turns', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  for (const folder of ['one', 'two']) {
    await mkdir(join(cwd, folder), { recursive: true })
    await writeFile(join(cwd, folder, 'report.md'), '# same\n')
  }
  const content = async (answer: string, name: string) => readFile(join(artifactDirectory(paths), decodeURIComponent(new RegExp(`\\[${name.replace('.', '\\.')}\\]\\(engram-artifact:([^)]+)\\)`).exec(answer)![1]!)), 'utf8')
  const linkOf = (answer: string, name: string) => new RegExp(`\\[${name.replace('.', '\\.')}\\]\\(engram-artifact:[^)]+\\)`).exec(answer)![0]
  const first = { answer: 'Wrote one/report.md and two/report.md.', steps: [passed('Reports written')] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  expect(first.steps.filter(step => step.tool === 'file_create_copy').map(step => [step.args.name, step.args.fromPath])).toEqual([['report.md', join(cwd, 'one', 'report.md')], ['report-2.md', join(cwd, 'two', 'report.md')]])
  const both = await judged(first)
  expect(both.outputs).toEqual(['report-2.md', 'report.md'])
  expect(both.check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(both.check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  expect(first.answer).toBe('Wrote one/report.md and two/report.md.')
  expect(cards(first).map(card => card.name)).toEqual(['report.md', 'report-2.md'])
  const one = linkOf(shown(first), 'report.md'), two = linkOf(shown(first), 'report-2.md')
  const later = Date.now() + 5_000, since = later - 1_000, touch = (folder: string) => utimes(join(cwd, folder, 'report.md'), later / 1000, later / 1000)
  await touch('two')
  const quoted = { answer: `Both reports stand: one/report.md and two/report.md.\n\n${one}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, quoted, since, 'ask')
  expect(quoted.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'two', 'report.md')]])
  expect(quoted.answer).toBe(`Both reports stand: one/report.md and two/report.md.\n\n${one}`)
  expect(withFiles('', cards(quoted)).trim()).toBe(two)
  await writeFile(join(cwd, 'two', 'report.md'), '# two v2\n')
  await touch('two')
  const revised = { answer: `Corrected two/report.md; one/report.md is unchanged.\n\n${one}\n\n${two}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, since, 'ask')
  expect(revised.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'two', 'report.md')]])
  expect(revised.answer).toBe(`Corrected two/report.md; one/report.md is unchanged.\n\n${one}\n\n${two}`)
  expect(await content(revised.answer, 'report.md')).toBe('# same\n')
  expect(cards(revised).map(card => card.name)).toEqual(['report-2.md'])
  expect(two).not.toContain(cards(revised)[0]!.href)
  expect(await saved(cards(revised)[0]!)).toBe('# two v2\n')
  await writeFile(join(cwd, 'two', 'report.md'), '# two v3\n')
  await touch('two')
  const other = { answer: `Corrected two/report.md again.\n\n${one}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, other, since, 'ask')
  expect(other.answer).toBe(`Corrected two/report.md again.\n\n${one}`)
  expect(cards(other).map(card => card.name)).toEqual(['report-2.md'])
  expect(await saved(cards(other)[0]!)).toBe('# two v3\n')
})

it('a link the answer already carries is not replaced by a same-name file from another folder', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const own = JSON.parse(await copy.run({ name: 'report.md', content: '# same\n' }, context)) as { markdownLink: string }
  for (const folder of ['one', 'two']) {
    await mkdir(join(cwd, folder), { recursive: true })
    await writeFile(join(cwd, folder, 'report.md'), '# same\n')
  }
  const result = { answer: `Also wrote one/report.md and two/report.md.\n\n${own.markdownLink}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toContain(own.markdownLink)
  expect(result.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'one', 'report.md')], ['report-3.md', join(cwd, 'two', 'report.md')]])
  expect((await judged(result)).outputs).toEqual(['report-2.md', 'report-3.md', 'report.md'])
})

it('a top-level file made on its own is handed in beside the same-byte copy of a subfolder file linked under its name', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  await mkdir(join(cwd, 'subfolder'), { recursive: true })
  for (const path of ['report.md', join('subfolder', 'report.md')]) await writeFile(join(cwd, path), '# same\n')
  const args = { name: 'report.md', fromPath: join(cwd, 'subfolder', 'report.md') }
  const step: TurnStep = { tool: 'file_create_copy', args, observation: await copy.run(args, context) }
  const own = JSON.parse(step.observation) as { markdownLink: string; taskPath: string }
  expect(own.taskPath).toBe(join(await realpath(cwd), 'report.md'))
  const result = { answer: `Wrote report.md and subfolder/report.md.\n\n${own.markdownLink}`, steps: [step, passed('Report written')] }
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe(`Wrote report.md and subfolder/report.md.\n\n${own.markdownLink}`)
  expect(cards(result).map(card => card.name)).toEqual(['report-2.md'])
  expect(result.steps.slice(2).map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'report.md')]])
  const after = await judged(result)
  expect(after.outputs).toEqual(['report-2.md', 'report.md'])
  expect(after.check).toMatchObject({ verified: false, issues: expect.arrayContaining([expect.stringContaining('Reread every final part of report-2.md')]) })
  await writeFile(join(cwd, 'subfolder', 'notes.md'), '# notes\n')
  const from = { name: 'notes.md', fromPath: join(cwd, 'subfolder', 'notes.md') }
  const placed: TurnStep = { tool: 'file_create_copy', args: from, observation: await copy.run(from, context) }
  const twin = { answer: `Wrote notes.md.\n\n${(JSON.parse(placed.observation) as { markdownLink: string }).markdownLink}`, steps: [placed] }
  await deliverOutputs(paths, cwd, twin, 0, 'ask')
  expect(twin.steps).toEqual([placed])
  expect(twin.answer).toBe(`Wrote notes.md.\n\n${(JSON.parse(placed.observation) as { markdownLink: string }).markdownLink}`)
  expect(cards(twin)).toEqual([])
})

it('a new copy under a name the answer still links from an older artifact gets its own link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const older = JSON.parse(await copy.run({ name: 'report.md', content: '# older report\n' }, context)) as { markdownLink: string }
  const args = { name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }
  const result = { answer: `Saved the report.\n\n${older.markdownLink}`, steps: [{ tool: 'file_create_copy', args, observation: await copy.run(args, context) }, passed('Report saved')] as TurnStep[] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe(`Saved the report.\n\n${older.markdownLink}`)
  expect(cards(result).map(card => card.name)).toEqual(['report-2.md'])
  const links = [...shown(result).matchAll(/\[(report(?:-2)?\.md)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# older report\n', '# from a/x\n'])
  expect(result.steps[0]).toMatchObject({ tool: 'file_create_copy', args: { name: 'report-2.md', fromPath: join(cwd, 'a', 'x.md') } })
  const { outputs, check } = await judged(result)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  const own = { answer: shown(result), steps: [...result.steps] }
  await deliverOutputs(paths, cwd, own, Date.now() + 60_000, 'ask')
  expect(own.answer).toBe(shown(result))
  expect(cards(own)).toEqual([])
})

it('two sources copied under one name in one turn, neither linked, each get their own name and link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true }); await mkdir(join(cwd, 'b'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n'); await writeFile(join(cwd, 'b', 'y.md'), '# from b/y\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  const result = { answer: 'Saved both reports.', steps: [await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }), await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') }), await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') }), passed('Reports saved')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Saved both reports.')
  const links = [...shown(result).matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(cards(result).map(saved))).toEqual(['# from a/x\n', '# from b/y\n'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.md', 'report-2.md', 'report-2.md', undefined])
  const { outputs, check } = await judged(result)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  for (const match of links) expect(check.issues.join(' ')).toContain(`Reread every final part of ${match[1]} (${join(artifactDirectory(paths), decodeURIComponent(match[2]!))})`)
  const again = { answer: shown(result), steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(shown(result))
  expect(cards(again)).toEqual([])
})
it('two inputs under one name that core attached are named apart, and reading the last one is not the readback of the first', async () => {
  const { outputCards } = await import('../../../packages/core/src/agent-session-result.js')
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true }); await mkdir(join(cwd, 'b'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n'); await writeFile(join(cwd, 'b', 'y.md'), '# from b/y\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  const pathOf = (step: TurnStep) => (JSON.parse(step.observation) as { path: string }).path
  const draft = await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x, fixed\n')
  const first = await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }), second = await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') })
  const reader = cometFileTools(paths, 'bot-x', [pathOf(first), pathOf(second)], [cwd]).find(tool => tool.name === 'file_read')!
  const reopen = async (path: string): Promise<TurnStep> => ({ tool: 'file_read', args: { path }, observation: await reader.run({ path }, context) })
  const creates = [draft, first, second]
  const seeded = outputCards(creates as unknown as Parameters<typeof outputCards>[0], 'Saved both reports.', cwd)
  expect(seeded.map(card => card.name)).toEqual(['report.md', 'report.md'])
  const attached = withFiles('Saved both reports.', seeded)
  const gate = async (steps: TurnStep[], answer: string) => checkResult(steps, latestResultOutputs(steps, await checkedOutputs(artifactDirectory(paths), answer)), [])
  expect((await checkedOutputs(artifactDirectory(paths), attached)).map(output => output.path)).toEqual([pathOf(first), pathOf(second)])
  const lastOnly = await gate([...creates, await reopen(pathOf(second)), passed('Reports saved')], attached)
  expect(lastOnly).toMatchObject({ accepted: false, verified: false })
  expect(lastOnly.issues).toEqual([expect.stringContaining(`Reread every final part of report.md (${pathOf(first)})`)])
  expect(await gate([...creates, await reopen(pathOf(first)), await reopen(pathOf(second)), passed('Reports saved')], attached)).toEqual({ accepted: true, verified: true, issues: [] })
  const result = { answer: 'Saved both reports.', files: [...seeded], steps: [...creates, await reopen(pathOf(second)), passed('Reports saved')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Saved both reports.')
  expect(await Promise.all(cards(result).map(saved))).toEqual(['# from a/x, fixed\n', '# from b/y\n'])
  expect(cards(result).map(card => card.name)).toEqual(['report.md', 'report-2.md'])
  expect(result.steps.slice(0, 3).map(step => step.args['name'])).toEqual(['report.md', 'report.md', 'report-2.md'])
  const delivered = await gate(result.steps, shown(result))
  expect(delivered).toMatchObject({ accepted: false, verified: false })
  expect(delivered.issues.join(' ')).toContain(`Reread every final part of report.md (${pathOf(first)})`)
  const again = { answer: shown(result), steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(shown(result))
  expect(cards(again)).toEqual([])
})
it('two price lists that core carded under one name leave delivery under names of their own, and the answer keeps its words', async () => {
  const { outputCards } = await import('../../../packages/core/src/agent-session-result.js')
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'spring'), { recursive: true }); await mkdir(join(cwd, 'autumn'), { recursive: true })
  await writeFile(join(cwd, 'spring', 'list.txt'), 'tulips 4\n'); await writeFile(join(cwd, 'autumn', 'list.txt'), 'dahlias 7\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (fromPath: string): Promise<TurnStep> => ({ tool: 'file_create_copy', args: { name: 'prices.txt', fromPath }, observation: await copy.run({ name: 'prices.txt', fromPath }, context) })
  const steps = [await made(join(cwd, 'spring', 'list.txt')), await made(join(cwd, 'autumn', 'list.txt'))]
  const seeded = outputCards(steps as unknown as Parameters<typeof outputCards>[0], 'Both price lists are ready.', cwd)
  expect(seeded.map(card => card.name)).toEqual(['prices.txt', 'prices.txt'])
  const result = { answer: 'Both price lists are ready.', files: [...seeded], steps }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Both price lists are ready.')
  expect(cards(result).map(card => card.name)).toEqual(['prices.txt', 'prices-2.txt'])
  expect(await Promise.all(cards(result).map(saved))).toEqual(['tulips 4\n', 'dahlias 7\n'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['prices.txt', 'prices-2.txt'])
})
it('two files rendered under one name in one turn each get their own name and link, and both enter the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const rendered = async (text: string): Promise<TurnStep> => ({ tool: 'render_file', args: { name: 'report.pdf', source: `${text}.md` }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`)), completeReadback: true }) })
  const result = { answer: 'Rendered both reports.', steps: [await rendered('first'), await rendered('second'), passed('Reports rendered')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Rendered both reports.')
  const links = [...shown(result).matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.pdf', 'report-2.pdf'])
  expect(await Promise.all(cards(result).map(saved))).toEqual(['%PDF-first', '%PDF-second'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.pdf', 'report-2.pdf', undefined])
  const steps = result.steps
  const outputs = latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: shown(result) }]))
  expect(outputs.map(output => [output.name, output.path]).sort()).toEqual(links.map(match => [match[1], join(artifactDirectory(paths), decodeURIComponent(match[2]!))]).sort())
  const again = { answer: shown(result), steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(shown(result))
  expect(cards(again)).toEqual([])
  const twice = { answer: 'Rendered.', steps: [await rendered('same'), await rendered('same')] }
  await deliverOutputs(paths, cwd, twice, Date.now() + 60_000, 'ask')
  expect(twice.answer).toBe('Rendered.')
  expect(cards(twice).map(card => card.name)).toEqual(['report.pdf'])
})
it('two packages edited under one name in one turn each get their own name and link, and both enter the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const edited = async (text: string): Promise<TurnStep> => ({ tool: 'file_edit_package', args: { name: 'report.docx', path: `${text}.docx` }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.docx', Buffer.from(`PK-${text}`)), completeReadback: true }) })
  const result = { answer: 'Edited both reports.', steps: [await edited('first'), await edited('second'), passed('Reports edited')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Edited both reports.')
  const links = [...shown(result).matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.docx', 'report-2.docx'])
  expect(await Promise.all(cards(result).map(saved))).toEqual(['PK-first', 'PK-second'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.docx', 'report-2.docx', undefined])
  const steps = result.steps
  const outputs = latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: shown(result) }]))
  expect(outputs.map(output => [output.name, output.path]).sort()).toEqual(links.map(match => [match[1], join(artifactDirectory(paths), decodeURIComponent(match[2]!))]).sort())
  const again = { answer: shown(result), steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(shown(result))
  expect(cards(again)).toEqual([])
  const twice = { answer: 'Edited.', steps: [await edited('same'), await edited('same')] }
  await deliverOutputs(paths, cwd, twice, Date.now() + 60_000, 'ask')
  expect(twice.answer).toBe('Edited.')
  expect(cards(twice).map(card => card.name)).toEqual(['report.docx'])
})
it('a report re-rendered and re-copied in one turn is handed over once per name, at the version the answer quotes', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const rendered = async (text: string): Promise<TurnStep> => {
    const saved = await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`))
    return { tool: 'render_file', args: { name: 'report.pdf', source: 'report.md' }, observation: JSON.stringify({ ...saved, completeReadback: true }) }
  }
  const copied = async (text: string, fromPath: string): Promise<TurnStep> => { await writeFile(join(cwd, fromPath), text); const args = { name: 'report.md', fromPath: join(cwd, fromPath) }; return { tool: 'file_create_copy', args, observation: await copy.run(args, context) } }
  await mkdir(cwd, { recursive: true })
  const steps = [await rendered('v1'), await copied('# v1\n', 'report.md'), await rendered('v2'), await rendered('v3'), await copied('# v3\n', 'report.md')]
  const real = await realpath(cwd)
  steps[0]!.observation = JSON.stringify({ ...JSON.parse(steps[0]!.observation) as object, taskPath: await placeInTask(real, 'report.pdf', Buffer.from('%PDF-v1'), twinsFile(paths, real)) })
  const link = (step: TurnStep) => (JSON.parse(step.observation) as { markdownLink: string }).markdownLink
  const result = { answer: `Done: report.pdf and report.md.\n\n${link(steps[3]!)}\n\n${link(steps[4]!)}`, steps: [...steps, passed('Report made')] }
  const quoted = result.answer
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe(quoted)
  expect(cards(result)).toEqual([])
  expect(result.steps).toHaveLength(steps.length + 1)
  const bare = { answer: 'Done.', steps: [await rendered('w1'), await rendered('w2'), passed('Report made')] }
  await deliverOutputs(paths, cwd, bare, Date.now() + 60_000, 'ask')
  expect(bare.answer).toBe('Done.')
  expect(cards(bare).map(card => card.name)).toEqual(['report.pdf'])
  expect(await saved(cards(bare)[0]!)).toBe('%PDF-w2')
  const earlier = [await rendered('x1'), await rendered('x2')]
  const kept = { answer: `Done.\n\n${link(earlier[0]!)}`, steps: [...earlier, passed('Report made')] }
  const asQuoted = kept.answer
  await deliverOutputs(paths, cwd, kept, Date.now() + 60_000, 'ask')
  expect(kept.answer).toBe(asQuoted)
  expect(cards(kept)).toEqual([])
})
it('a second file made from another input under a linked name is still handed over', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const rendered = async (text: string, input: Record<string, string>): Promise<TurnStep> => ({ tool: 'render_file', args: { name: 'report.pdf', ...input }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`)), completeReadback: true }) })
  const link = (step: TurnStep) => (JSON.parse(step.observation) as { markdownLink: string }).markdownLink
  const named = (answer: string) => [...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  const bytes = async (answer: string) => Promise.all(named(answer).map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))
  for (const [first, second] of [[{ source: 'sales.md' }, { source: 'costs.md' }], [{ markdown: '# Sales' }, { markdown: '# Costs' }], [{ html: '<p>Sales</p>' }, { html: '<p>Costs</p>' }]]) {
    const steps = [await rendered('sales', first!), await rendered('costs', second!)]
    const result = { answer: `Both reports are ready.\n\n${link(steps[1]!)}`, steps: [...steps, passed('Reports rendered')] }
    await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
    expect(result.answer).toBe(`Both reports are ready.\n\n${link(steps[1]!)}`)
    expect(cards(result).map(card => card.name)).toEqual(['report-2.pdf'])
    expect(named(shown(result)).map(match => match[1])).toEqual(['report.pdf', 'report-2.pdf'])
    expect(await bytes(shown(result))).toEqual(['%PDF-costs', '%PDF-sales'])
    const bare = { answer: 'Both reports are ready.', steps: [await rendered('sales', first!), await rendered('costs', second!), passed('Reports rendered')] }
    await deliverOutputs(paths, cwd, bare, Date.now() + 60_000, 'ask')
    expect(bare.answer).toBe('Both reports are ready.')
    expect(cards(bare).map(card => card.name)).toEqual(['report.pdf', 'report-2.pdf'])
    expect(await Promise.all(cards(bare).map(saved))).toEqual(['%PDF-sales', '%PDF-costs'])
  }
  const again = { answer: 'Done.', steps: [await rendered('a1', { markdown: '# Sales' }), await rendered('a2', { markdown: '# Sales' }), passed('Report made')] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe('Done.')
  expect(cards(again).map(card => card.name)).toEqual(['report.pdf'])
  expect(await Promise.all(cards(again).map(saved))).toEqual(['%PDF-a2'])
})
it('a content copy revised in the same turn is linked once, at its last revision', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  const result = { answer: 'Saved.', steps: [await made({ name: 'notes.md', content: '# draft\n' }), await made({ name: 'notes.md', content: '# final\n' })] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toBe('Saved.')
  expect(cards(result).map(card => card.name)).toEqual(['notes.md'])
  expect(await saved(cards(result)[0]!)).toBe('# final\n')
})

it('a new top-level file never takes over a link the comet made from another source: it gets its own name and link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const args = { name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }
  const own = JSON.parse(await copy.run(args, context)) as { markdownLink: string }
  const first = { answer: `Saved a/x.md as the report.\n\n${own.markdownLink}`, steps: [{ tool: 'file_create_copy', args, observation: JSON.stringify(own) }] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  expect(first.steps).toHaveLength(1)
  expect(first.answer).toBe(`Saved a/x.md as the report.\n\n${own.markdownLink}`)
  expect(cards(first)).toEqual([])
  await writeFile(join(cwd, 'report.md'), '# another report\n')
  const later = { answer: `Wrote report.md.\n\n${own.markdownLink}`, steps: [passed('Report written')] }
  await deliverOutputs(paths, cwd, later, 0, 'ask')
  expect(later.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'report-2.md', fromPath: join(cwd, 'report.md') } })
  expect(later.answer).toBe(`Wrote report.md.\n\n${own.markdownLink}`)
  expect(cards(later).map(card => card.name)).toEqual(['report-2.md'])
  const links = [...shown(later).matchAll(/\[(report(?:-2)?\.md)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# from a/x\n', '# another report\n'])
  const { outputs, check } = await judged(later)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x, v2\n')
  const revised = { answer: `Corrected a/x.md.\n\n${own.markdownLink}\n\n${links[1]![0]}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report.md', join(cwd, 'a', 'x.md')]])
  expect(revised.answer).toBe(`Corrected a/x.md.\n\n${own.markdownLink}\n\n${links[1]![0]}`)
  expect(cards(revised).map(card => card.name)).toEqual(['report.md'])
  expect(own.markdownLink).not.toContain(cards(revised)[0]!.href)
  expect(await saved(cards(revised)[0]!)).toBe('# from a/x, v2\n')
  const loose = JSON.parse(await copy.run({ name: 'notes.md', content: '# notes\n' }, context)) as { markdownLink: string }
  await writeFile(join(cwd, 'notes.md'), '# other notes\n')
  const unknown = { answer: `Wrote notes.md.\n\n${loose.markdownLink}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, unknown, 0, 'ask')
  expect(unknown.answer).toBe(`Wrote notes.md.\n\n${loose.markdownLink}`)
  expect(unknown.steps.map(step => step.args.name)).toEqual(['notes-2.md'])
  expect(cards(unknown).map(card => card.name)).toEqual(['notes-2.md'])
})

it('a check turn hands in a requested script it first wrote next to a linked workbook, and it enters the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const book = JSON.parse(await copy.run({ name: 'audit.csv', content: 'a,b\n1,2\n' }, context)) as { markdownLink: string }
  await writeFile(join(cwd, 'audit.py'), 'print("audited")\n')
  const ran: TurnStep = { tool: 'Bash', args: { command: 'python3 audit.py' }, observation: 'audited' }
  const result = { answer: `Wrote audit.py, the automation you asked for, and ran it.\n\n${book.markdownLink}`, steps: [ran, passed('Automation script written')] }
  await deliverOutputs(paths, cwd, result, 0, 'Check the result.\n\nThe delegated task, verbatim:\nAudit the workbook and give me a script that repeats it.')
  expect(result.answer).toBe(`Wrote audit.py, the automation you asked for, and ran it.\n\n${book.markdownLink}`)
  expect(cards(result).map(card => card.name)).toEqual(['audit.py'])
  expect((await judged(result)).outputs).toEqual(['audit.csv', 'audit.py'])
})

it('a command that only mentions a script changes nothing: handed in when the answer names it, left alone when it does not', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'audit.py'), 'print("audited")\n')
  await writeFile(join(cwd, 'summary.md'), '# new\n')
  const echo: TurnStep = { tool: 'Bash', args: { command: 'echo audit.py' }, observation: 'audit.py' }
  for (const steps of [[passed('Script written')], [echo, passed('Script written')]]) {
    const named = { answer: 'Wrote summary.md and audit.py.', steps: [...steps] }
    await deliverOutputs(paths, cwd, named, 0, 'ask')
    expect(named.answer).toBe('Wrote summary.md and audit.py.')
    expect(cards(named).map(card => card.name).sort()).toEqual(['audit.py', 'summary.md'])
    const { outputs, check } = await judged(named)
    expect(outputs).toEqual(['audit.py', 'summary.md'])
    expect(check.issues.join(' ')).toContain('Reread every final part of summary.md')
    const unnamed = { answer: 'Wrote summary.md.', steps: [...steps] }
    await deliverOutputs(paths, cwd, unnamed, 0, 'ask')
    expect(unnamed.answer).toBe('Wrote summary.md.')
    expect(cards(unnamed).map(card => card.name)).toEqual(['summary.md'])
    expect((await judged(unnamed)).outputs).toEqual(['summary.md'])
  }
})

it('the host hand-in of a file revised in a check turn is not a change after the report, while the model\'s own still is', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'report.md'), '# v1\n')
  const first = { answer: 'Saved report.md.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  expect(first.answer).toBe('Saved report.md.')
  expect(cards(first).map(card => card.name)).toEqual(['report.md'])
  const link = withFiles('', cards(first)).trim()
  await writeFile(join(cwd, 'report.md'), '# v2\n')
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  const read: TurnStep = { tool: 'file_read', args: { path: join(cwd, 'report.md') }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: join(cwd, 'report.md') }, context) }
  const finding = { status: 'pass', basis: 'Read the corrected file.' }
  const report: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ ...finding, requirement: 'Report corrected' }], grounding: finding } }) }
  const judge = async (result: Shown & { steps: TurnStep[] }) => checkResult(result.steps, latestResultOutputs(result.steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: shown(result) }])), [])
  const revised = { answer: `Corrected report.md.\n\n${link}`, steps: [read, report] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps.at(-1)!.tool).toBe('file_create_copy')
  expect(revised.answer).toBe(`Corrected report.md.\n\n${link}`)
  expect(cards(revised).map(card => card.name)).toEqual(['report.md'])
  expect(await saved(cards(revised)[0]!)).toBe('# v2\n')
  expect(await judge(revised)).toMatchObject({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(revised.steps)).toBe(true)
  await writeFile(join(cwd, 'report.md'), '# v3\n')
  const unread = { answer: revised.answer, steps: [read, report] }
  await deliverOutputs(paths, cwd, unread, 0, 'ask')
  expect((await judge(unread)).issues.join(' ')).toContain('Reread every final part of report.md')
  const own: TurnStep = { tool: 'file_create_copy', args: { name: 'report.md', fromPath: join(cwd, 'report.md') }, observation: await tools.find(tool => tool.name === 'file_create_copy')!.run({ name: 'report.md', fromPath: join(cwd, 'report.md') }, context) }
  expect((await judge({ answer: revised.answer, steps: [read, report, own] })).issues.join(' ')).toContain('The result changed after report_result_check')
  expect(freshResultReadback([read, report, own])).toBe(false)
})

it('attaches a named file core will not read back, and says so when nothing can be attached', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sales.csv'), `a,b\n${'1,2\n'.repeat(2_200_000)}`)
  const result = { answer: 'Saved sales.csv.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe('Saved sales.csv.')
  expect(cards(result)).toEqual([{ name: 'sales.csv', href: expect.stringMatching(/sales\.csv$/) }])
  await writeFile(join(cwd, 'bad.png'), 'not a picture')
  const broken = { answer: 'Saved bad.png.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, broken, 0, 'ask')
  expect(broken.answer).toBe('Saved bad.png.')
  expect(cards(broken)).toEqual([])
  expect(broken.steps).toEqual([])
})
