import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { CHECK_SCRATCH, continuationPrompt, vaultPaths, type DelegatedTask, type TurnStep, type VaultPaths } from 'core'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => `${state.home}/${name}` }, dialog: { showMessageBox: vi.fn() }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: {}, nativeImage: {}, BrowserWindow: class {}, session: {} }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => undefined }))
import { artifactDirectory, checkedOutputs, cometFileTools, linkedOutputs, OUTPUT_BYTES, placeInTask, resolveOutput, saveOutput, taskFile, twinsFile } from '../src/main/file-work.js'
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

// c10c review r1: a workbook this turn made and then changed with file_edit_package is one file: the answer links the edit, and the
// first version is not handed over beside it under another name.
it('does not hand over a file this turn made and then edited', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  // c11c: the edit is known by the file it read (the workbook's task-folder twin, which its receipt names), not by the shared name.
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
  // The turn that made the copy carries its receipt: the task-folder twin is on record as this link's source.
  const made: TurnStep = { tool: 'file_create_copy', args: { name: 'report.py', content: 'print(1)\n' }, observation: JSON.stringify(draft) }
  const same = { answer, steps: [made] }
  await deliverOutputs(paths, cwd, same, 0, 'ask')
  expect(same.answer).toBe(answer)
  expect(same.steps).toEqual([made])
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
  // qa142 p2a-r8 A: the follow-up's report is not re-judged against the report before it; the host carries that one over, and the follow-up only adds the reads.
  const both: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: ['Leads merged', 'No duplicate leads'].map(requirement => ({ status: 'pass', basis: 'Compared.', requirement })), grounding: { status: 'pass', basis: 'Compared.' } } }) }
  const held = async (report: TurnStep, reads = [artifact, handedIn]) => {
    const steps = [...await Promise.all(reads.map(reopen)), report]
    return checkResult(steps, latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: byCommand.answer }])), [], false)
  }
  // Both files read, one requirement left out of the follow-up's report: verified, since that report cannot drop a check the host already judged.
  const dropped = await held(passed('Leads merged'))
  expect(dropped).toEqual({ accepted: true, verified: true, issues: [] })
  expect(dropped.issues.join(' ')).not.toContain('leaves out a requirement check')
  // The same report without the read of the handed-in file: not verified.
  const oneRead = await held(passed('Leads merged'), [artifact])
  expect(oneRead).toMatchObject({ accepted: false, verified: false })
  expect(oneRead.issues.join(' ')).toContain('Reread every final part of check_merge.py')
  // A check the follow-up itself reports as no longer passing: unresolved, not verified.
  const failing: TurnStep = { ...both, observation: both.observation.replace('"status":"pass","basis":"Compared.","requirement":"No duplicate leads"', '"status":"unknown","basis":"Not compared.","requirement":"No duplicate leads"') }
  expect(await held(failing)).toMatchObject({ verified: false, issues: ['No duplicate leads: unknown — Not compared.'] })
  // Every requirement restated as passed, with the reads: verified, so S31 ends done.
  expect(await held(both)).toEqual({ accepted: true, verified: true, issues: [] })
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
  // qa143 p2 r3 #2: the script ran after merged.md was read and a command has no receipt of what it wrote, so that read is stale;
  // the same turn with the read after the run is fresh.
  expect(freshResultReadback(checked.steps)).toBe(false)
  expect(freshResultReadback([wrote, ran, read, ...checked.steps.slice(3)])).toBe(true)
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

// qa143 p2 r5 (S19b): a re-check that ran out of budget answers with the budget note, which links no file, so the host judged no file of the
// report it was re-checking: a passing check and a read of some other file were accepted, and the runner then let the unread report stand as done.
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
  // The other file was read, fresh, and every check passed: the report's own file is still unread, so the host does not accept the check.
  const unrelated = [await reopen(notes.path), passed('Leads merged')]
  expect(freshResultReadback(unrelated)).toBe(true)
  expect(await recheck(unrelated)).toMatchObject({ accepted: false, verified: false, issues: [expect.stringContaining(`Reread every final part of report.md (${report.path})`)] })
  // The same for a re-check that ended in its own words without the link.
  expect(await recheck(unrelated, 'Checked again; nothing to correct.')).toMatchObject({ accepted: false, issues: [expect.stringContaining('Reread every final part of report.md')] })
  expect(await recheck([passed('Leads merged')])).toMatchObject({ accepted: false })
  // Its own file read back in full: accepted.
  expect(await recheck([await reopen(report.path), passed('Leads merged')])).toEqual({ accepted: true, verified: true, issues: [] })
  // A turn that re-checks nothing answers for its own links only, as before.
  expect(await checkedOutputs(artifactDirectory(paths), budgetNote)).toEqual([])
  expect(await checkedOutputs(artifactDirectory(paths), earlier)).toEqual([{ name: 'report.md', path: report.path }])
  // qa143 p2 r6 (S19b): the re-check makes its own report.md, reads only that one in full and passes. The report that will stand links the
  // earlier report.md, which nobody read: it stays an unchecked output beside the new one, with or without the host's link to the new one.
  const made = async (content: string): Promise<{ step: TurnStep; path: string; link: string }> => { const observation = await tools.find(tool => tool.name === 'file_create_copy')!.run({ name: 'report.md', content }, context), saved = JSON.parse(observation) as { path: string; markdownLink: string }; return { step: { tool: 'file_create_copy', args: { name: 'report.md', content }, observation }, path: saved.path, link: saved.markdownLink } }
  const newer = await made('# another report\n')
  expect(newer.path).not.toBe(report.path)
  const sameName = [newer.step, await reopen(newer.path), passed('Leads merged')]
  expect(freshResultReadback(sameName)).toBe(true)
  for (const answer of [budgetNote, `${budgetNote}\n\n${newer.link}`]) {
    expect(await recheck(sameName, answer)).toMatchObject({ accepted: false, verified: false, issues: [expect.stringContaining(`Reread every final part of report.md (${report.path})`)] })
    expect(latestResultOutputs(sameName, await checkedOutputs(artifactDirectory(paths), answer, earlier, true)).map(output => output.path)).toEqual([report.path, newer.path])
  }
  // A later copy under the name does not push the report's own file out either, also after the report's bytes were made again.
  const again = await made('# report\n'), third = await made('# third\n')
  expect(again.path).toBe(report.path)
  expect((await recheck([again.step, third.step, await reopen(third.path), passed('Leads merged')])).issues.join(' ')).toContain(`Reread every final part of report.md (${report.path})`)
  // Made again and not read since: the earlier read does not count.
  expect(await recheck([await reopen(report.path), again.step, passed('Leads merged')])).toMatchObject({ accepted: false })
  // Both read back, the report's own included: accepted.
  expect(await recheck([newer.step, await reopen(newer.path), await reopen(report.path), passed('Leads merged')], `${budgetNote}\n\n${newer.link}`)).toEqual({ accepted: true, verified: true, issues: [] })
  // A re-check whose own answer stands (no budget stop) and links its corrected report.md answers for that one, as before.
  expect(await checkedOutputs(artifactDirectory(paths), `Corrected. ${newer.link}`, earlier)).toEqual([{ name: 'report.md', path: newer.path }])
  // qa143 p2 r9 (S19a): the report linked two different files under one name. A re-check whose own answer stands and links and reads only one
  // of them, or a new file of that name, does not drop the others: each is a file by its path and still needs its own readback.
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
  // merged.md is on record as the source of the link (r12: no file is taken for a linked one by its place and bytes alone).
  expect(await mentionedOutputs(cwd, checked.answer, 0, [], artifactDirectory(paths), { 'merged.md': 'merged.md' })).toEqual([])
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

// qa142 p2a-r7 #2: a receipt is linked by its own artifact, not by a file name the answer already links.
// qa143 p2 r12 (S19a): the inverse of the case above. The copy came from subfolder/report.md, and a top-level report.md made on its own holds
// the same bytes. The receipt found that file already there and names it as its task copy, but did not place it: it is a second source.
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
  expect(result.answer).toContain(own.markdownLink)
  expect(result.answer).toMatch(/\[report-2\.md\]\(engram-artifact:/)
  expect(result.steps.slice(2).map(step => [step.args.name, step.args.fromPath])).toEqual([['report-2.md', join(cwd, 'report.md')]])
  const after = await judged(result)
  expect(after.outputs).toEqual(['report-2.md', 'report.md'])
  // The second file needs its own full readback: the read of report.md is not it.
  expect(after.check).toMatchObject({ verified: false, issues: expect.arrayContaining([expect.stringContaining('Reread every final part of report-2.md')]) })
  // The copy the receipt itself placed is its twin and nothing more: with no top-level file before the copy, one link.
  await writeFile(join(cwd, 'subfolder', 'notes.md'), '# notes\n')
  const from = { name: 'notes.md', fromPath: join(cwd, 'subfolder', 'notes.md') }
  const placed: TurnStep = { tool: 'file_create_copy', args: from, observation: await copy.run(from, context) }
  const twin = { answer: `Wrote notes.md.\n\n${(JSON.parse(placed.observation) as { markdownLink: string }).markdownLink}`, steps: [placed] }
  await deliverOutputs(paths, cwd, twin, 0, 'ask')
  expect(twin.steps).toEqual([placed])
  expect([...twin.answer.matchAll(/\(engram-artifact:/g)]).toHaveLength(1)
})

it('a new copy under a name the answer still links from an older artifact gets its own link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const older = JSON.parse(await copy.run({ name: 'report.md', content: '# older report\n' }, context)) as { markdownLink: string }
  // This turn copies a source from before the turn (ignored by mtime) under the same name; the answer keeps only the older link.
  const args = { name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }
  const result = { answer: `Saved the report.\n\n${older.markdownLink}`, steps: [{ tool: 'file_create_copy', args, observation: await copy.run(args, context) }, passed('Report saved')] as TurnStep[] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  expect(result.answer).toContain(older.markdownLink)
  const links = [...result.answer.matchAll(/\[(report(?:-2)?\.md)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# older report\n', '# from a/x\n'])
  expect(result.steps[0]).toMatchObject({ tool: 'file_create_copy', args: { name: 'report-2.md', fromPath: join(cwd, 'a', 'x.md') } })
  const { outputs, check } = await judged(result)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  // Its own artifact linked: nothing is added, also when another file of that name is linked beside it.
  const own = { answer: result.answer, steps: [...result.steps] }
  await deliverOutputs(paths, cwd, own, Date.now() + 60_000, 'ask')
  expect(own.answer).toBe(result.answer)
})

// qa142 p2a-r8 B: every receipt of the turn is linked, not only the last one per name.
it('two sources copied under one name in one turn, neither linked, each get their own name and link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true }); await mkdir(join(cwd, 'b'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n'); await writeFile(join(cwd, 'b', 'y.md'), '# from b/y\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  // The second source is copied twice: its first copy is a revision that the last one replaces.
  const result = { answer: 'Saved both reports.', steps: [await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }), await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') }), await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') }), passed('Reports saved')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  const links = [...result.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# from a/x\n', '# from b/y\n'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.md', 'report-2.md', 'report-2.md', undefined])
  const { outputs, check } = await judged(result)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  // Each name is checked at the artifact its link carries: report.md is still the first source's, not the second source's earlier copy.
  for (const match of links) expect(check.issues.join(' ')).toContain(`Reread every final part of ${match[1]} (${join(artifactDirectory(paths), decodeURIComponent(match[2]!))})`)
  // Run again over the same steps: each receipt's own artifact is linked, so nothing is added.
  const again = { answer: result.answer, steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(result.answer)
})
// qa143 p2 r8 (S19a): the answer linked neither of two inputs copied under one name, so core attached both as report.md. The host found each
// one's own link and left them, files were known by name, and a passing check that read only the last one verified a turn whose first file was never read back.
it('two inputs under one name that core attached are named apart, and reading the last one is not the readback of the first', async () => {
  const { outputLinks } = await import('../../../packages/core/src/agent-session-result.js')
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true }); await mkdir(join(cwd, 'b'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n'); await writeFile(join(cwd, 'b', 'y.md'), '# from b/y\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  const pathOf = (step: TurnStep) => (JSON.parse(step.observation) as { path: string }).path
  // The first input is made twice: its earlier copy is a revision, and only the last one is a file.
  const draft = await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x, fixed\n')
  const first = await made({ name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }), second = await made({ name: 'report.md', fromPath: join(cwd, 'b', 'y.md') })
  const reader = cometFileTools(paths, 'bot-x', [pathOf(first), pathOf(second)], [cwd]).find(tool => tool.name === 'file_read')!
  const reopen = async (path: string): Promise<TurnStep> => ({ tool: 'file_read', args: { path }, observation: await reader.run({ path }, context) })
  const creates = [draft, first, second]
  const attached = outputLinks(creates as unknown as Parameters<typeof outputLinks>[0], 'Saved both reports.', cwd)
  expect([...attached.matchAll(/\[([^\]]+)\]\(engram-artifact:/g)].map(match => match[1])).toEqual(['report.md', 'report.md'])
  const gate = async (steps: TurnStep[], answer: string) => checkResult(steps, latestResultOutputs(steps, await checkedOutputs(artifactDirectory(paths), answer)), [])
  // The gate itself, where nothing renamed them (a turn that asked is not delivered): both linked files are checked, each by its path.
  expect((await checkedOutputs(artifactDirectory(paths), attached)).map(output => output.path)).toEqual([pathOf(first), pathOf(second)])
  const lastOnly = await gate([...creates, await reopen(pathOf(second)), passed('Reports saved')], attached)
  expect(lastOnly).toMatchObject({ accepted: false, verified: false })
  expect(lastOnly.issues).toEqual([expect.stringContaining(`Reread every final part of report.md (${pathOf(first)})`)])
  expect(await gate([...creates, await reopen(pathOf(first)), await reopen(pathOf(second)), passed('Reports saved')], attached)).toEqual({ accepted: true, verified: true, issues: [] })
  // Delivered: the second input is named apart, both are handed over, and the same last-only read still leaves the first unread.
  const result = { answer: attached, steps: [...creates, await reopen(pathOf(second)), passed('Reports saved')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  const links = [...result.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# from a/x, fixed\n', '# from b/y\n'])
  expect(result.steps.slice(0, 3).map(step => step.args['name'])).toEqual(['report.md', 'report.md', 'report-2.md'])
  const delivered = await gate(result.steps, result.answer)
  expect(delivered).toMatchObject({ accepted: false, verified: false })
  expect(delivered.issues.join(' ')).toContain(`Reread every final part of report.md (${pathOf(first)})`)
  // Run again: each file's own link is there under its own name, so nothing changes.
  const again = { answer: result.answer, steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(result.answer)
})
// qa142 p2a-r9 #1: a creation receipt with no fromPath is its own source, not one shared empty source where only the last per name survives.
// qa143 S19: that source is what it was made from (here two source files); one input rendered again is a revision (see the S19 test below).
it('two files rendered under one name in one turn each get their own name and link, and both enter the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const rendered = async (text: string): Promise<TurnStep> => ({ tool: 'render_file', args: { name: 'report.pdf', source: `${text}.md` }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`)), completeReadback: true }) })
  const result = { answer: 'Rendered both reports.', steps: [await rendered('first'), await rendered('second'), passed('Reports rendered')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  const links = [...result.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.pdf', 'report-2.pdf'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['%PDF-first', '%PDF-second'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.pdf', 'report-2.pdf', undefined])
  const steps = result.steps
  const outputs = latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: result.answer }]))
  // Each name is checked at the artifact its own link carries.
  expect(outputs.map(output => [output.name, output.path]).sort()).toEqual(links.map(match => [match[1], join(artifactDirectory(paths), decodeURIComponent(match[2]!))]).sort())
  // Run again over the same steps: each receipt's own artifact is linked, so nothing is added.
  const again = { answer: result.answer, steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(result.answer)
  // The same bytes rendered twice are one artifact: one link.
  const twice = { answer: 'Rendered.', steps: [await rendered('same'), await rendered('same')] }
  await deliverOutputs(paths, cwd, twice, Date.now() + 60_000, 'ask')
  expect([...twice.answer.matchAll(/\(engram-artifact:/g)]).toHaveLength(1)
})
// qa142 p2a-r10: that holds for any tool's receipt with no fromPath, not a list of tools: two edited packages under one name are two files.
it('two packages edited under one name in one turn each get their own name and link, and both enter the result check', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const edited = async (text: string): Promise<TurnStep> => ({ tool: 'file_edit_package', args: { name: 'report.docx', path: `${text}.docx` }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.docx', Buffer.from(`PK-${text}`)), completeReadback: true }) })
  const result = { answer: 'Edited both reports.', steps: [await edited('first'), await edited('second'), passed('Reports edited')] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  const links = [...result.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.docx', 'report-2.docx'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['PK-first', 'PK-second'])
  expect(result.steps.map(step => step.args['name'])).toEqual(['report.docx', 'report-2.docx', undefined])
  const steps = result.steps
  const outputs = latestResultOutputs(steps, await linkedOutputs(artifactDirectory(paths), [{ role: 'assistant', text: result.answer }]))
  // Each name is checked at the artifact its own link carries.
  expect(outputs.map(output => [output.name, output.path]).sort()).toEqual(links.map(match => [match[1], join(artifactDirectory(paths), decodeURIComponent(match[2]!))]).sort())
  // Run again over the same steps: each receipt's own artifact is linked, so nothing is added.
  const again = { answer: result.answer, steps: [...result.steps] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(again.answer).toBe(result.answer)
  // The same bytes edited twice are one artifact: one link.
  const twice = { answer: 'Edited.', steps: [await edited('same'), await edited('same')] }
  await deliverOutputs(paths, cwd, twice, Date.now() + 60_000, 'ask')
  expect([...twice.answer.matchAll(/\(engram-artifact:/g)]).toHaveLength(1)
})
// qa143 S19 (a): a report rendered three times while it was being fixed, and its markdown copied twice, was handed over as report.pdf plus
// report-2/-3/-4.pdf and report-2.md: every render was its own deliverable, and the first render's copy in the task folder one more.
it('a report re-rendered and re-copied in one turn is handed over once per name, at the version the answer quotes', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const rendered = async (text: string): Promise<TurnStep> => {
    const saved = await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`))
    return { tool: 'render_file', args: { name: 'report.pdf', source: 'report.md' }, observation: JSON.stringify({ ...saved, completeReadback: true }) }
  }
  // qa143 p2 r2 #2: a revision is the same input made again: one markdown file rendered and copied after each fix.
  const copied = async (text: string, fromPath: string): Promise<TurnStep> => { await writeFile(join(cwd, fromPath), text); const args = { name: 'report.md', fromPath: join(cwd, fromPath) }; return { tool: 'file_create_copy', args, observation: await copy.run(args, context) } }
  await mkdir(cwd, { recursive: true })
  const steps = [await rendered('v1'), await copied('# v1\n', 'report.md'), await rendered('v2'), await rendered('v3'), await copied('# v3\n', 'report.md')]
  // The first render left its own copy in the task folder, as render_file does (its receipt names it); the later ones were cleaned up.
  // Placed the way the tool places it, so it is on record as that receipt's twin (r12: a twin is known by the placement record, not by its bytes).
  const real = await realpath(cwd)
  steps[0]!.observation = JSON.stringify({ ...JSON.parse(steps[0]!.observation) as object, taskPath: await placeInTask(real, 'report.pdf', Buffer.from('%PDF-v1'), twinsFile(paths, real)) })
  const link = (step: TurnStep) => (JSON.parse(step.observation) as { markdownLink: string }).markdownLink
  const result = { answer: `Done: report.pdf and report.md.\n\n${link(steps[3]!)}\n\n${link(steps[4]!)}`, steps: [...steps, passed('Report made')] }
  const quoted = result.answer
  await deliverOutputs(paths, cwd, result, 0, 'ask')
  expect(result.answer).toBe(quoted)
  expect(result.steps).toHaveLength(steps.length + 1)
  // With no link in the answer, each name still gets exactly one: its last version.
  const bare = { answer: 'Done.', steps: [await rendered('w1'), await rendered('w2'), passed('Report made')] }
  await deliverOutputs(paths, cwd, bare, Date.now() + 60_000, 'ask')
  const links = [...bare.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.pdf'])
  expect(await readFile(join(artifactDirectory(paths), decodeURIComponent(links[0]![2]!)), 'utf8')).toBe('%PDF-w2')
  // Where the answer quotes an earlier version, that one is handed over and the later render of the same input is not added beside it.
  const earlier = [await rendered('x1'), await rendered('x2')]
  const kept = { answer: `Done.\n\n${link(earlier[0]!)}`, steps: [...earlier, passed('Report made')] }
  const asQuoted = kept.answer
  await deliverOutputs(paths, cwd, kept, Date.now() + 60_000, 'ask')
  expect(kept.answer).toBe(asQuoted)
})
// qa143 p2 r2 #2: the answer linking one file of a name hid every other file of that name made in the turn, another source's included, and
// inline renders of different html or markdown shared one empty source, so only the last was handed over.
it('a second file made from another input under a linked name is still handed over', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const rendered = async (text: string, input: Record<string, string>): Promise<TurnStep> => ({ tool: 'render_file', args: { name: 'report.pdf', ...input }, observation: JSON.stringify({ ...await saveOutput(artifactDirectory(paths), 'report.pdf', Buffer.from(`%PDF-${text}`)), completeReadback: true }) })
  const link = (step: TurnStep) => (JSON.parse(step.observation) as { markdownLink: string }).markdownLink
  const named = (answer: string) => [...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  const bytes = async (answer: string) => Promise.all(named(answer).map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))
  for (const [first, second] of [[{ source: 'sales.md' }, { source: 'costs.md' }], [{ markdown: '# Sales' }, { markdown: '# Costs' }], [{ html: '<p>Sales</p>' }, { html: '<p>Costs</p>' }]]) {
    // The answer quotes the second file only.
    const steps = [await rendered('sales', first!), await rendered('costs', second!)]
    const result = { answer: `Both reports are ready.\n\n${link(steps[1]!)}`, steps: [...steps, passed('Reports rendered')] }
    await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
    expect(named(result.answer).map(match => match[1])).toEqual(['report.pdf', 'report-2.pdf'])
    expect(await bytes(result.answer)).toEqual(['%PDF-costs', '%PDF-sales'])
    // With no link in the answer, both are handed over as well.
    const bare = { answer: 'Both reports are ready.', steps: [await rendered('sales', first!), await rendered('costs', second!), passed('Reports rendered')] }
    await deliverOutputs(paths, cwd, bare, Date.now() + 60_000, 'ask')
    expect(named(bare.answer).map(match => match[1])).toEqual(['report.pdf', 'report-2.pdf'])
    expect(await bytes(bare.answer)).toEqual(['%PDF-sales', '%PDF-costs'])
  }
  // The same inline input rendered again is one file made again: its last version only.
  const again = { answer: 'Done.', steps: [await rendered('a1', { markdown: '# Sales' }), await rendered('a2', { markdown: '# Sales' }), passed('Report made')] }
  await deliverOutputs(paths, cwd, again, Date.now() + 60_000, 'ask')
  expect(named(again.answer).map(match => match[1])).toEqual(['report.pdf'])
  expect(await bytes(again.answer)).toEqual(['%PDF-a2'])
})
// Content written twice under one name is one file revised: only the last revision is linked.
it('a content copy revised in the same turn is linked once, at its last revision', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const made = async (args: Record<string, unknown>): Promise<TurnStep> => ({ tool: 'file_create_copy', args, observation: await copy.run(args, context) })
  const result = { answer: 'Saved.', steps: [await made({ name: 'notes.md', content: '# draft\n' }), await made({ name: 'notes.md', content: '# final\n' })] }
  await deliverOutputs(paths, cwd, result, Date.now() + 60_000, 'ask')
  const links = [...result.answer.matchAll(/\[([^\]]+)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['notes.md'])
  expect(await readFile(join(artifactDirectory(paths), decodeURIComponent(links[0]![2]!)), 'utf8')).toBe('# final\n')
})

// qa142 p2a-r6 #1: a linked name is claimed only by the source its file_create_copy receipt names; with no record it is never replaced.
it('a new top-level file never takes over a link the comet made from another source: it gets its own name and link, and both are checked', async () => {
  const cwd = await workFolderFor(paths, 'bot-x')
  await mkdir(join(cwd, 'a'), { recursive: true })
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x\n')
  const copy = cometFileTools(paths, 'bot-x', [], [cwd]).find(tool => tool.name === 'file_create_copy')!
  const args = { name: 'report.md', fromPath: join(cwd, 'a', 'x.md') }
  const own = JSON.parse(await copy.run(args, context)) as { markdownLink: string }
  const first = { answer: `Saved a/x.md as the report.\n\n${own.markdownLink}`, steps: [{ tool: 'file_create_copy', args, observation: JSON.stringify(own) }] as TurnStep[] }
  await deliverOutputs(paths, cwd, first, 0, 'ask')
  // Its twin in the task folder and its source are the linked bytes: nothing more is handed in.
  expect(first.steps).toHaveLength(1)
  expect(first.answer).toBe(`Saved a/x.md as the report.\n\n${own.markdownLink}`)
  // A later turn writes another report.md at the top of the task folder.
  await writeFile(join(cwd, 'report.md'), '# another report\n')
  const later = { answer: `Wrote report.md.\n\n${own.markdownLink}`, steps: [passed('Report written')] }
  await deliverOutputs(paths, cwd, later, 0, 'ask')
  expect(later.steps.at(-1)).toMatchObject({ tool: 'file_create_copy', args: { name: 'report-2.md', fromPath: join(cwd, 'report.md') } })
  expect(later.answer).toContain(own.markdownLink)
  const links = [...later.answer.matchAll(/\[(report(?:-2)?\.md)\]\(engram-artifact:([^)]+)\)/g)]
  expect(links.map(match => match[1])).toEqual(['report.md', 'report-2.md'])
  expect(await Promise.all(links.map(match => readFile(join(artifactDirectory(paths), decodeURIComponent(match[2]!)), 'utf8')))).toEqual(['# from a/x\n', '# another report\n'])
  const { outputs, check } = await judged(later)
  expect(outputs).toEqual(['report-2.md', 'report.md'])
  expect(check.issues.join(' ')).toContain('Reread every final part of report.md')
  expect(check.issues.join(' ')).toContain('Reread every final part of report-2.md')
  // The receipt's own source still revises its own link.
  await writeFile(join(cwd, 'a', 'x.md'), '# from a/x, v2\n')
  const revised = { answer: `Corrected a/x.md.\n\n${own.markdownLink}\n\n${links[1]![0]}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, revised, 0, 'ask')
  expect(revised.steps.map(step => [step.args.name, step.args.fromPath])).toEqual([['report.md', join(cwd, 'a', 'x.md')]])
  expect(revised.answer).not.toContain(own.markdownLink)
  expect(revised.answer).toContain(links[1]![0])
  // No receipt in the trail and no record: the link is left alone, whatever the task folder holds under its name.
  const loose = JSON.parse(await copy.run({ name: 'notes.md', content: '# notes\n' }, context)) as { markdownLink: string }
  await writeFile(join(cwd, 'notes.md'), '# other notes\n')
  const unknown = { answer: `Wrote notes.md.\n\n${loose.markdownLink}`, steps: [] as TurnStep[] }
  await deliverOutputs(paths, cwd, unknown, 0, 'ask')
  expect(unknown.answer).toContain(loose.markdownLink)
  expect(unknown.steps.map(step => step.args.name)).toEqual(['notes-2.md'])
  expect(unknown.answer).toMatch(/\[notes-2\.md\]\(engram-artifact:/)
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
