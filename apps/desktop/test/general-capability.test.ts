import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { CHECK_SCRATCH, continuationPrompt, vaultPaths, type DelegatedTask, type TurnStep, type VaultPaths } from 'core'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => `${state.home}/${name}` }, dialog: { showMessageBox: vi.fn() }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: {}, nativeImage: {}, BrowserWindow: class {}, session: {} }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
import { artifactDirectory, cometFileTools, linkedOutputs, OUTPUT_BYTES, placeInTask, resolveOutput, saveOutput, taskFile } from '../src/main/file-work.js'
import { cometNativeTools, deliverOutputs, mentionedOutputs, nativeDecision, rememberWorkFolder, workFolderFor, type NativePolicy } from '../src/main/native-tools.js'
import { checkResult, latestResultOutputs } from '../src/main/result-check.js'
import { freshResultReadback } from '../src/main/task-result-state.js'

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
  await truncate(join(cwd, 'report.py'), OUTPUT_BYTES + 1)
  const huge = { answer, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, huge, 0, 'ask')
  expect(huge.answer).toContain('report.py is larger than 50 MB')
})

const passed = (requirement: string): TurnStep => ({ tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ status: 'pass', basis: 'Compared.', requirement }], grounding: { status: 'pass', basis: 'Compared.' } } }) })
const judged = async (result: { answer: string; steps: TurnStep[] }) => {
  const outputs = latestResultOutputs(result.steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: result.answer }]))
  return { outputs: outputs.map(output => output.name).sort(), check: checkResult(result.steps, outputs, []) }
}

// B14 (S31): the helper a check turn wrote into the task folder is handed in after its report. That hand-in is the host's copy,
// not a change to the result, so a turn whose checks all passed is verified and the script is one more file.
it('a check turn whose checks passed stays verified when its comparison script is handed in from the task folder', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  const first = JSON.parse(await tools.find(tool => tool.name === 'file_create_copy')!.run({ name: 'merged.md', content: '# merged\n' }, context)) as { markdownLink: string; path: string }
  const link = first.markdownLink, artifact = first.path
  const read: TurnStep = { tool: 'file_read', args: { path: artifact }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: artifact }, context) }
  await writeFile(join(cwd, 'check_merge.py'), 'print(0)\n')
  // The S31 turn itself: the helper was made by a command, so no write of the turn showed its bytes. Every check passed, yet the script is a text
  // result nobody read: the one issue is its readback, named as a hand-in so the runner gives the readback-only turn instead of stopping.
  const ran: TurnStep = { tool: 'Bash', args: { command: 'python3 check_merge.py' }, observation: '0 mismatches' }
  const made: TurnStep = { tool: 'Bash', args: { command: "printf 'print(0)\\n' > check_merge.py" }, observation: '' }
  const byCommand = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, made, ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, byCommand, 0, 'ask')
  expect(byCommand.answer).toMatch(/\[check_merge\.py\]\(engram-artifact:/)
  expect(byCommand.answer).toContain(link)
  expect(byCommand.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'check_merge.py' } })
  const before = await judged(byCommand)
  expect(before.outputs).toEqual(['check_merge.py', 'merged.md'])
  const handedIn = JSON.parse(byCommand.steps.at(-1)!.observation).path as string
  expect(before.check).toMatchObject({ accepted: false, verified: false, readbacks: [{ name: 'check_merge.py', path: handedIn }] })
  expect(before.check.issues).toHaveLength(1)
  expect(before.check.issues[0]).toContain('Reread every final part of check_merge.py')
  // The readback-only turn: nothing is changed or handed in again; both final files are read in full and the report is made again. It ends done.
  // As in the app, the turn's file tools may read the files linked in the result it was given.
  const later = cometFileTools(paths, 'bot-x', (await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: byCommand.answer }])).map(output => output.path), [cwd])
  const reopen = async (path: string): Promise<TurnStep> => ({ tool: 'file_read', args: { path }, observation: await later.find(tool => tool.name === 'file_read')!.run({ path }, context) })
  const followUp = { answer: byCommand.answer, steps: [await reopen(artifact), await reopen(handedIn), passed('Leads merged')] }
  await deliverOutputs(paths, cwd, followUp, Date.now() + 60_000, 'ask')
  expect(followUp.steps).toHaveLength(3)
  expect(followUp.answer).toBe(byCommand.answer)
  const second = await judged(followUp)
  expect(second.outputs).toEqual(['check_merge.py', 'merged.md'])
  expect(second.check).toEqual({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(followUp.steps)).toBe(true)
  // A readback turn that reads only one of them is still not verified.
  expect((await judged({ answer: byCommand.answer, steps: [await reopen(artifact), passed('Leads merged')] })).check.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  // The Write-created variant. The script is a text result too: its final bytes are known because they equal what the turn's own Write call wrote.
  const wrote: TurnStep = { tool: 'Write', args: { file_path: join(cwd, 'check_merge.py'), content: 'print(0)\n' }, observation: 'Native action completed.' }
  const checked = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, wrote, ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, checked, 0, 'ask')
  expect(checked.answer).toMatch(/\[check_merge\.py\]\(engram-artifact:/)
  expect(checked.answer).toContain(link)
  expect(checked.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'check_merge.py' } })
  const { outputs, check } = await judged(checked)
  expect(outputs).toEqual(['check_merge.py', 'merged.md'])
  expect(check).toMatchObject({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(checked.steps)).toBe(true)
  // What ended S31 as "unresolved checks": the same hand-in step without the host's mark reads as a change after the report.
  const unmarked = checked.steps.map(step => step.tool === 'file_create_copy' ? { ...step, observation: JSON.stringify({ ...JSON.parse(step.observation), handedInFrom: undefined }) } : step)
  expect(checkResult(unmarked, latestResultOutputs(unmarked, []), []).issues.join(' ')).toContain('The result changed after report_result_check')
  expect(freshResultReadback(unmarked)).toBe(false)
  // A script a command changed after that write, never reread, is not the bytes the model wrote: the check asks for its readback.
  await writeFile(join(cwd, 'check_merge.py'), 'print(1)\n')
  const patched: TurnStep = { tool: 'Bash', args: { command: 'sed -i s/0/1/ check_merge.py && cat check_merge.py' }, observation: 'print(1)\n' }
  const changed = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [read, wrote, patched, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, changed, 0, 'ask')
  const drifted = (await judged(changed)).check
  expect(drifted).toMatchObject({ accepted: false, verified: false })
  expect(drifted.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  // Rereading the task file in full at those bytes before the report is the readback.
  const reread: TurnStep = { tool: 'file_read', args: { path: join(cwd, 'check_merge.py') }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: join(cwd, 'check_merge.py') }, context) }
  const seen = { answer: changed.answer.replace(/\n\n\[check_merge\.py\][^\n]*/, ''), steps: [read, wrote, patched, reread, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, seen, 0, 'ask')
  expect((await judged(seen)).check).toMatchObject({ accepted: true, verified: true, issues: [] })
  await writeFile(join(cwd, 'check_merge.py'), 'print(0)\n')
  // The real deliverable is still held to its readback: without the read of merged.md the same turn is not verified.
  const unread = { answer: `Compared with check_merge.py: 0 mismatches.\n\n${link}`, steps: [ran, passed('Leads merged')] }
  await deliverOutputs(paths, cwd, unread, 0, 'ask')
  expect((await judged(unread)).check.issues.join(' ')).toContain('Reread every final part of merged.md')
})

it('scratch in the check folder the answer does not name stays out, and a file there the answer names is handed in and checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, CHECK_SCRATCH, 'deep'), { recursive: true })
  await writeFile(join(cwd, 'merged.md'), '# merged\n')
  const first = { answer: 'Saved merged.md.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  const link = /\[merged\.md\]\(engram-artifact:[^)]+\)/.exec(first.answer)![0]
  // Any kind of file, at any depth, run or not: unnamed scratch is not a result.
  for (const name of ['check_merge.py', 'diff.md', join('deep', 'counts.csv')]) await writeFile(join(cwd, CHECK_SCRATCH, name), 'x\n')
  const ran: TurnStep = { tool: 'Bash', args: { command: `python3 ${CHECK_SCRATCH}/check_merge.py` }, observation: '0 mismatches' }
  const steps = [ran, passed('Leads merged')]
  const checked = { answer: `Compared the merged file with the sources: 0 mismatches.\n\n${link}`, steps: [...steps] }
  await deliverOutputs(paths, cwd, checked, 0, 'ask')
  expect(checked.steps).toEqual(steps)
  expect(checked.answer).not.toMatch(/\[(check_merge\.py|diff\.md|counts\.csv)\]/)
  expect((await judged(checked)).outputs).toEqual(['merged.md'])
  expect(await mentionedOutputs(cwd, checked.answer, 0)).toEqual([])
  const prompt = continuationPrompt({ goal: 'Merge the leads.', result: 'Saved merged.md.' } as DelegatedTask, 'verify')
  expect(prompt).toContain(`inside the ${CHECK_SCRATCH}/ folder`)
  expect(prompt).toContain('only when your answer names it')
  // A requested deliverable that landed there is not dropped: the answer names it, so it is handed in and needs its readback.
  await writeFile(join(cwd, CHECK_SCRATCH, 'report.md'), '# audit\n')
  const named = { answer: `Wrote ${CHECK_SCRATCH}/report.md.\n\n${link}`, steps: [passed('Report written')] }
  await deliverOutputs(paths, cwd, named, 0, 'ask')
  expect(named.answer).toMatch(/\[report\.md\]\(engram-artifact:/)
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
  const links = [...result.answer.matchAll(/\[(report(?:-2)?\.md)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# one\n', '# two\n'])
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
  // Identical bytes, one name: both are handed in and both enter the check.
  const first = { answer: 'Wrote one/report.md and two/report.md.', steps: [passed('Reports written')] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  expect(first.steps.filter(step => step.tool === 'file_create_copy').map(step => [step.args.name, step.args.fromPath])).toEqual([['report.md', join(cwd, 'one', 'report.md')], ['report-2.md', join(cwd, 'two', 'report.md')]])
  const both = await judged(first)
  expect(both.outputs).toEqual(['report-2.md', 'report.md'])
  expect(both.check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(both.check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  const one = linkOf(first.answer, 'report.md'), two = linkOf(first.answer, 'report-2.md')
  // A later turn that quotes only one/report.md's link: the unchanged identical two/report.md is not taken for it, and its link is added, not swapped in.
  // since sits a second under the touched time: a set mtime can read back a hair below the value given.
  const later = Date.now() + 5_000, since = later - 1_000, touch = (folder: string) => utimes(join(cwd, folder, 'report.md'), later / 1000, later / 1000)
  await touch('two')
  const quoted = { answer: `Both reports stand: one/report.md and two/report.md.\n\n${one}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, quoted, since, 'ask')
  expect(quoted.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'two', 'report.md')]])
  expect(quoted.answer).toContain(one)
  expect(quoted.answer).toContain(two)
  // Only two/report.md changes: one/report.md's link stays on one/report.md, and two/report.md's link moves to the new bytes.
  await writeFile(join(cwd, 'two', 'report.md'), '# two v2\n')
  await touch('two')
  const revised = { answer: `Corrected two/report.md; one/report.md is unchanged.\n\n${one}\n\n${two}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, since, 'ask')
  expect(revised.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'two', 'report.md')]])
  expect(revised.answer).toContain(one)
  expect(revised.answer).not.toContain(two)
  expect(await content(revised.answer, 'report.md')).toBe('# same\n')
  expect(await content(revised.answer, 'report-2.md')).toBe('# two v2\n')
  expect([...revised.answer.matchAll(/\(engram-artifact:/g)]).toHaveLength(2)
  // Same when the changed file is the only one the turn touched and the answer quotes only the other's link.
  await writeFile(join(cwd, 'two', 'report.md'), '# two v3\n')
  await touch('two')
  const other = { answer: `Corrected two/report.md again.\n\n${one}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, other, since, 'ask')
  expect(other.answer).toContain(one)
  expect(await content(other.answer, 'report-2.md')).toBe('# two v3\n')
})

it('a link the answer already carries is not replaced by a same-name file from another folder', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  // The comet's own copy: linked as report.md, with its twin at the top of the task folder.
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

it('a check turn hands in a requested script it first wrote next to a linked workbook, and it enters the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const book = JSON.parse(await copy.run({ name: 'audit.csv', content: 'a,b\n1,2\n' }, context)) as { markdownLink: string }
  // Named nowhere before, run by the turn, beside another linked result: every sign the old guess read as "helper".
  await writeFile(join(cwd, 'audit.py'), 'print("audited")\n')
  const ran: TurnStep = { tool: 'Bash', args: { command: 'python3 audit.py' }, observation: 'audited' }
  const result = { answer: `Wrote audit.py, the automation you asked for, and ran it.\n\n${book.markdownLink}`, steps: [ran, passed('Automation script written')] }
  await deliverOutputs(paths, cwd, result, 0, 'Check the result.\n\nThe delegated task, verbatim:\nAudit the workbook and give me a script that repeats it.')
  expect(result.answer).toMatch(/\[audit\.py\]\(engram-artifact:/)
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
    expect(named.answer).toMatch(/\[audit\.py\]\(engram-artifact:/)
    const { outputs, check } = await judged(named)
    expect(outputs).toEqual(['audit.py', 'summary.md'])
    // A new deliverable never read in full this turn is delivered, but not reported as checked.
    expect(check.issues.join(' ')).toContain('Reread every final part of summary.md')
    const unnamed = { answer: 'Wrote summary.md.', steps: [...steps] }
    await deliverOutputs(paths, cwd, unnamed, 0, 'ask')
    expect(unnamed.answer).not.toContain('audit.py')
    expect((await judged(unnamed)).outputs).toEqual(['summary.md'])
  }
})

it('the host hand-in of a file revised in a check turn is not a change after the report, while the model\'s own still is', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'report.md'), '# v1\n')
  const first = { answer: 'Saved report.md.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  const link = /\[report\.md\]\(engram-artifact:[^)]+\)/.exec(first.answer)![0]
  await writeFile(join(cwd, 'report.md'), '# v2\n')
  const tools = cometFileTools(paths, 'bot-x', [], [cwd])
  const read: TurnStep = { tool: 'file_read', args: { path: join(cwd, 'report.md') }, observation: await tools.find(tool => tool.name === 'file_read')!.run({ path: join(cwd, 'report.md') }, context) }
  const finding = { status: 'pass', basis: 'Read the corrected file.' }
  const report: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ ...finding, requirement: 'Report corrected' }], grounding: finding } }) }
  const judge = async (result: { answer: string; steps: TurnStep[] }) => checkResult(result.steps, latestResultOutputs(result.steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: result.answer }])), [])
  const revised = { answer: `Corrected report.md.\n\n${link}`, steps: [read, report] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps.at(-1)!.tool).toBe('file_create_copy')
  expect(await judge(revised)).toMatchObject({ accepted: true, verified: true, issues: [] })
  expect(freshResultReadback(revised.steps)).toBe(true)
  // Revised but never read back in full: the hand-in alone proves nothing.
  await writeFile(join(cwd, 'report.md'), '# v3\n')
  const unread = { answer: revised.answer, steps: [read, report] }
  await deliverOutputs(paths, cwd, unread, 0, 'ask')
  expect((await judge(unread)).issues.join(' ')).toContain('Reread every final part of report.md')
  // The model's own copy after its report is still a change after the report.
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
  expect(result.answer).toMatch(/\[sales\.csv\]\(engram-artifact:[^)]+sales\.csv\)/)
  await writeFile(join(cwd, 'bad.png'), 'not a picture')
  const broken = { answer: 'Saved bad.png.', steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, broken, 0, 'ask')
  expect(broken.answer).toContain('bad.png could not be attached')
})
