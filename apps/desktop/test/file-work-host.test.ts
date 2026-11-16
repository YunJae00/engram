import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { vaultPaths } from '../../../packages/core/src/vault.js'

// Reads outside the usual folders are asked in the chat (state.ask), never with an app-modal dialog (state.dialog).
const state = vi.hoisted(() => ({ stopped: false, confirm: vi.fn(), dialog: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: state.getPath }, dialog: { showMessageBox: state.dialog }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: { showItemInFolder: vi.fn() } }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => { if (state.stopped) throw new Error('Stopped for this turn') } }))
import { pathToFileURL } from 'node:url'
import { cometFileTools as hostFileTools, placeInTask, taskOutputs, twinsFile } from '../src/main/file-work.js'

// Every chat has its in-chat approval card; state.confirm answers it.
const cometFileTools = (paths: Parameters<typeof hostFileTools>[0], lane: string, attached: string[] = [], handIn: string[] = []) => hostFileTools(paths, lane, attached, handIn, { ask: state.confirm })

let root: string
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/file-host-'))
  await mkdir(join(root, 'private'))
  // Documents, Desktop and Downloads: read without asking. Files elsewhere ask.
  await mkdir(join(root, 'home'))
  state.stopped = false
  state.confirm.mockReset().mockResolvedValue('approve')
  state.dialog.mockReset()
  state.getPath.mockReset().mockImplementation(() => join(root, 'home'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('does not expose the private vault even through a model-selected file path', async () => {
  const path = join(root, 'private', 'note.txt')
  await writeFile(path, 'private')
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Private vault')
  expect(state.confirm).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('checks the canonical target after approval so an alias cannot expose private files', async () => {
  const target = join(root, 'private', 'note.txt')
  const path = join(root, 'alias.txt')
  await writeFile(target, 'private')
  await symlink(target, path)
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Private vault')
  expect(state.confirm).toHaveBeenCalledOnce()
})

it('requires an exact-path native consent and honors Stop during the consent dialog', async () => {
  const path = join(root, 'input.json')
  await writeFile(path, '{"safe":true}')
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  state.confirm.mockImplementation(async () => { state.stopped = true; return 'approve' })
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Stopped')
  expect(state.confirm.mock.calls[0]![0].words).toContain(path)
  expect(state.confirm.mock.calls[0]![0].url).toBe(`${pathToFileURL(path).href}#read`)
})

it('reads explicitly attached copies without asking to approve their contents again', async () => {
  const path = join(root, 'input.json')
  await writeFile(path, '{"safe":true}')
  const tool = cometFileTools(vaultPaths(root), 'lane', [path]).find((tool) => tool.name === 'file_read')!
  expect(JSON.parse(await tool.run({ path }, { task: 'Read the attached file.' })).content).toBe('{"safe":true}')
  expect(state.confirm).not.toHaveBeenCalled()
})

it('does not carry an interrupted read approval into a fresh tool session', async () => {
  const path=join(root,'review.txt')
  await writeFile(path,'draft r1')
  let answer!: (value:'approve'|'cancel')=>void
  state.confirm.mockImplementationOnce(()=>new Promise(resolve=>{answer=resolve}))
  const controller=new AbortController()
  const old=cometFileTools(vaultPaths(root),'lane').find(t=>t.name==='file_read')!
  const pending=old.run({path},{task:'Read the draft',signal:controller.signal})
  const rejected=expect(pending).rejects.toThrow()
  await vi.waitFor(()=>expect(state.confirm).toHaveBeenCalledOnce())
  controller.abort()
  answer('approve')
  await rejected
  await writeFile(path,'draft r2')
  state.confirm.mockResolvedValueOnce('cancel')
  const fresh=cometFileTools(vaultPaths(root),'lane').find(t=>t.name==='file_read')!
  await expect(fresh.run({path},{task:'Continue reading'})).rejects.toThrow()
  expect(state.confirm).toHaveBeenCalledTimes(2)
})

it('does not bypass a cancelled desktop turn by switching to file creation', async () => {
  state.stopped = true
  const tools = cometFileTools(vaultPaths(root), 'lane')
  for (const name of ['file_create_copy', 'file_create_workbook']) {
    await expect(tools.find((tool) => tool.name === name)!.run({}, { task: 'Keep working.' })).rejects.toThrow('Stopped')
  }
  expect(await readdir(root)).toEqual(['home', 'private'])
})

it('can inspect a workbook it just created without asking again, but does not trust another chat output', async () => {
  const tools = cometFileTools(vaultPaths(root), 'lane')
  const context = { task: 'Create and verify a workbook.' }
  const args = { name: 'budget.xlsx', sheet: 'Budget', rows: [['Cost'], [123]] }
  const created = JSON.parse(await tools.find(tool => tool.name === 'file_create_workbook')!.run(args, context))
  await tools.find(tool => tool.name === 'file_read_package')!.run({ path: created.path }, context)
  const inspected = JSON.parse(await tools.find(tool => tool.name === 'file_read_workbook')!.run({ path: created.path, sheet: 'Budget' }, context))
  expect(inspected.columns[0].literalSum).toBe(123)
  expect(state.confirm).not.toHaveBeenCalled()
  const other = cometFileTools(vaultPaths(root), 'other')
  await other.find(tool => tool.name === 'file_read_package')!.run({ path: created.path }, context)
  expect(state.confirm).toHaveBeenCalledOnce()
})

it('uses operating-system document folders for discovery without approving or reading content', async () => {
  await writeFile(join(root, 'home', 'budget.pdf'), 'content stays local')
  const tool = cometFileTools(vaultPaths(root), 'lane').find(tool => tool.name === 'find_files')!
  const result = JSON.parse(await tool.run({ query: 'budget' }, { task: 'Find the budget file' }))
  expect(result.matches[0].path).toBe(join(root, 'home', 'budget.pdf'))
  expect(state.getPath.mock.calls.map(call => call[0])).toEqual(['documents', 'desktop', 'downloads'])
  expect(state.confirm).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('content stays local')
})

it('reads a file in Documents, Desktop or Downloads without asking, as the runtime file tools do', async () => {
  const path = join(root, 'home', 'issues.json')
  await writeFile(path, '{"open":3}')
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  expect(JSON.parse(await tool.run({ path }, { task: 'Read the issue list.' })).content).toBe('{"open":3}')
  expect(state.confirm).not.toHaveBeenCalled()
})

// QA 0.8.142 B6: re-reading its own just-made copy raised a parentless native
// dialog that froze the whole app for ~10 minutes.
it('never opens an app-modal dialog: a read outside the usual folders is asked in the chat, in the person\'s language', async () => {
  const path = join(root, 'outside.txt')
  await writeFile(path, 'outside')
  const ask = vi.fn().mockResolvedValue('approve')
  const tool = hostFileTools(vaultPaths(root), 'lane', [], [], { ask, korean: () => true }).find(t => t.name === 'file_read')!
  expect(JSON.parse(await tool.run({ path }, { task: '파일 읽어줘' })).content).toBe('outside')
  expect(ask).toHaveBeenCalledOnce()
  expect(ask.mock.calls[0]![0].words).toMatch(/^이 파일을 읽어도 될까요\?/)
  expect(ask.mock.calls[0]![0].words).toContain(path)
  // Approved once for this exact path in this tool session.
  await tool.run({ path }, { task: '다시 읽어줘' })
  expect(ask).toHaveBeenCalledOnce()
  expect(state.dialog).not.toHaveBeenCalled()
})

it('declines, without any dialog, a read outside the usual folders when there is no chat to ask in', async () => {
  const path = join(root, 'outside.txt')
  await writeFile(path, 'outside')
  const tool = hostFileTools(vaultPaths(root), 'lane').find(t => t.name === 'file_read')!
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow()
  expect(state.dialog).not.toHaveBeenCalled()
})

it('a declined chat card keeps the file unread', async () => {
  const path = join(root, 'outside.txt')
  await writeFile(path, 'secret plan')
  const ask = vi.fn().mockResolvedValue('cancel')
  const tool = hostFileTools(vaultPaths(root), 'lane', [], [], { ask }).find(t => t.name === 'file_read')!
  const result = await tool.run({ path }, { task: 'Read a file.' }).catch((error: Error) => error.message)
  expect(String(result)).not.toContain('secret plan')
  expect(ask).toHaveBeenCalledOnce()
})

it('re-reads a copy it just handed in, and files in its own task folder, without asking', async () => {
  const task = join(root, 'workspace', 'tasks', 'lane')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'draft.csv'), 'a,b\n1,2\n')
  const ask = vi.fn().mockResolvedValue('cancel')
  const tools = hostFileTools(vaultPaths(root), 'lane', [], [task], { ask })
  const context = { task: 'Make and check a sheet.' }
  const created = JSON.parse(await tools.find(t => t.name === 'file_create_copy')!.run({ name: 'expenses.csv', content: 'item,amount\nlunch,12000\n' }, context))
  expect(JSON.parse(await tools.find(t => t.name === 'file_read')!.run({ path: created.path }, context)).content).toContain('lunch')
  expect(JSON.parse(await tools.find(t => t.name === 'file_read')!.run({ path: join(task, 'draft.csv') }, context)).content).toContain('1,2')
  expect(ask).not.toHaveBeenCalled()
  expect(state.dialog).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('does not trust a task folder that is a link to another chat\'s folder', async () => {
  const other = join(root, 'workspace', 'tasks', 'other')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'notes.txt'), 'other chat')
  const linked = join(root, 'workspace', 'tasks', 'lane')
  await symlink(other, linked)
  const ask = vi.fn().mockResolvedValue('cancel')
  const tool = hostFileTools(vaultPaths(root), 'lane', [], [linked], { ask }).find(t => t.name === 'file_read')!
  const result = await tool.run({ path: join(other, 'notes.txt') }, { task: 'Read notes.' }).catch((error: Error) => error.message)
  expect(String(result)).not.toContain('other chat')
  expect(ask).toHaveBeenCalledOnce()
})

// codex p1 r3: the hand-in path (file_create_copy fromPath) used the raw task
// folder, so a linked folder let the comet copy another chat's file unasked.
it.skipIf(process.platform === 'win32')('does not hand in another chat\'s file through a linked task folder', async () => {
  const other = join(root, 'workspace', 'tasks', 'other')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'notes.txt'), 'other chat')
  const linked = join(root, 'workspace', 'tasks', 'lane')
  await symlink(other, linked)
  const ask = vi.fn().mockResolvedValue('approve')
  const tool = hostFileTools(vaultPaths(root), 'lane', [], [linked], { ask }).find(t => t.name === 'file_create_copy')!
  const result = await tool.run({ name: 'stolen.txt', fromPath: join(linked, 'notes.txt') }, { task: 'Copy notes.' }).catch((error: Error) => error.message)
  expect(String(result)).not.toContain('other chat')
  expect(String(result)).toMatch(/task folder/)
  await expect(readdir(join(root, 'workspace', 'outputs')).catch(() => [])).resolves.not.toContain('stolen.txt')
  expect(ask).not.toHaveBeenCalled()
})

// QA 0.8.145 S02/S04: word_write and ppt_build save through taskOutputs, which the file tools knew nothing of, so the readback
// the receipt itself asks for raised "이 파일을 읽어도 될까요?" on the comet's own new file and stalled the turn.
it('reads back a document another tool of this turn composed, without asking', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane')
  const made = new Set<string>(), ask = vi.fn().mockResolvedValue('cancel')
  const receipt = await taskOutputs(paths, async () => task, made).save('주간 회의록.md', Buffer.from('출시일 11/28 확정'))
  const read = hostFileTools(paths, 'lane', [], [task], { ask, made }).find(t => t.name === 'file_read')!
  expect(JSON.parse(await read.run({ path: receipt.path }, { task: '회의록 만들어 줘' })).content).toContain('11/28')
  expect(JSON.parse(await read.run({ path: receipt.taskPath }, { task: '회의록 만들어 줘' })).content).toContain('11/28')
  expect(ask).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('still asks for everything that is not this turn\'s own output', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane'), other = join(root, 'workspace', 'tasks', 'other')
  const made = new Set<string>(), ask = vi.fn().mockResolvedValue('cancel')
  await taskOutputs(paths, async () => task, made).save('mine.md', Buffer.from('mine'))
  // Another chat's output and task file, a file of the person's elsewhere, and a link out of the task folder.
  const foreign = await taskOutputs(paths, async () => other).save('theirs.md', Buffer.from('other chat'))
  await writeFile(join(root, 'person.md'), 'the person\'s own')
  await symlink(join(root, 'person.md'), join(task, 'link.md'))
  // A recorded path that has since become a link is not the output that was saved.
  const swapped = join(root, 'workspace', 'swapped.md')
  await symlink(join(root, 'person.md'), swapped)
  made.add(swapped)
  const gated = [foreign.path as string, foreign.taskPath as string, join(root, 'person.md'), join(task, 'link.md'), swapped]
  for (const path of gated) {
    // A decline ends reads for the session, so each path gets a fresh one.
    const read = hostFileTools(paths, 'lane', [], [task], { ask, made }).find(t => t.name === 'file_read')!
    const result = await read.run({ path }, { task: 'Read it.' }).catch((error: Error) => error.message)
    expect(String(result)).toMatch(/declined/)
  }
  expect(ask).toHaveBeenCalledTimes(gated.length)
})

// QA 0.8.145 S03/S33: a remake of a.xlsx left "a (2).xlsx" beside it in the task folder, one more per fix.
it('a remake replaces its own earlier copy in the task folder instead of piling up numbered ones', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane'), outputs = taskOutputs(paths, async () => task)
  const first = await outputs.save('a.xlsx', Buffer.from('v1'))
  const second = await outputs.save('a.xlsx', Buffer.from('v2'))
  const third = await outputs.save('a.xlsx', Buffer.from('v3'))
  expect(third.taskPath).toBe(first.taskPath)
  expect((await readdir(task)).sort()).toEqual(['a.xlsx'])
  expect(await readFile(join(task, 'a.xlsx'), 'utf8')).toBe('v3')
  // The earlier versions stay in the saved outputs, where the chat's "(이전)" link points.
  expect(await readFile(first.path as string, 'utf8')).toBe('v1')
  expect(await readFile(second.path as string, 'utf8')).toBe('v2')
})

it('never replaces a file it did not place, or one changed since it was placed', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane'), outputs = taskOutputs(paths, async () => task)
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'budget.xlsx'), 'the person\'s own')
  expect(await outputs.save('budget.xlsx', Buffer.from('v1'))).toMatchObject({ taskPath: expect.stringContaining('budget (2).xlsx') })
  // Its own numbered copy is the one a remake replaces; the person's file is untouched.
  expect(await outputs.save('budget.xlsx', Buffer.from('v2'))).toMatchObject({ taskPath: expect.stringContaining('budget (2).xlsx') })
  expect(await readFile(join(task, 'budget.xlsx'), 'utf8')).toBe('the person\'s own')
  expect(await readFile(join(task, 'budget (2).xlsx'), 'utf8')).toBe('v2')
  // Edited after it was placed (by the person or a script): kept, and the new one is numbered.
  await writeFile(join(task, 'budget (2).xlsx'), 'edited by hand')
  expect(await outputs.save('budget.xlsx', Buffer.from('v3'))).toMatchObject({ taskPath: expect.stringContaining('budget (3).xlsx') })
  expect(await readFile(join(task, 'budget (2).xlsx'), 'utf8')).toBe('edited by hand')
  // With no placement record nothing is known to be its own.
  await placeInTask(task, 'plain.md', Buffer.from('one'))
  expect(await placeInTask(task, 'plain.md', Buffer.from('two'))).toContain('plain (2).md')
  expect(await readFile(twinsFile(paths, await (await import('node:fs/promises')).realpath(task)), 'utf8')).not.toContain('plain')
})

// qa145 r2 #1: the record keeps every version's hash. A person who puts v1's bytes back by hand has their own file, not the comet's latest copy.
it('keeps a file a person set back to an earlier version, and numbers the next remake', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane'), outputs = taskOutputs(paths, async () => task)
  await outputs.save('a.xlsx', Buffer.from('v1'))
  await outputs.save('a.xlsx', Buffer.from('v2'))
  await writeFile(join(task, 'a.xlsx'), 'v1')
  expect(await outputs.save('a.xlsx', Buffer.from('v3'))).toMatchObject({ taskPath: expect.stringContaining('a (2).xlsx') })
  expect(await readFile(join(task, 'a.xlsx'), 'utf8')).toBe('v1')
  expect(await readFile(join(task, 'a (2).xlsx'), 'utf8')).toBe('v3')
})

// qa145 r2 #2 (qa143 S19a): two inputs under one name in one turn are two deliverables, each with its own task-folder copy.
it('keeps two different inputs under one name as two task files, and replaces only the same deliverable made again', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane')
  await mkdir(join(task, 'one'), { recursive: true })
  await mkdir(join(task, 'two'), { recursive: true })
  await writeFile(join(task, 'one', 'report.md'), 'from one')
  await writeFile(join(task, 'two', 'report.md'), 'from two')
  const copy = (turn: string) => hostFileTools(paths, 'lane', [], [task], { turn }).find(tool => tool.name === 'file_create_copy')!
  const first = JSON.parse(await copy('t1').run({ name: 'report.md', fromPath: join(task, 'one', 'report.md') }, { task: 'x' }))
  const second = JSON.parse(await copy('t1').run({ name: 'report.md', fromPath: join(task, 'two', 'report.md') }, { task: 'x' }))
  expect(second.taskPath).not.toBe(first.taskPath)
  expect(await readFile(first.taskPath, 'utf8')).toBe('from one')
  expect(await readFile(second.taskPath, 'utf8')).toBe('from two')
  // The same task file copied again after an edit is its revision, in this turn or a later one; the other task file's copy stays, also in a later turn.
  await writeFile(join(task, 'one', 'report.md'), 'from one, fixed')
  expect(JSON.parse(await copy('t1').run({ name: 'report.md', fromPath: join(task, 'one', 'report.md') }, { task: 'x' })).taskPath).toBe(first.taskPath)
  await writeFile(join(task, 'two', 'report.md'), 'from two, fixed')
  expect(JSON.parse(await copy('t2').run({ name: 'report.md', fromPath: join(task, 'two', 'report.md') }, { task: 'x' })).taskPath).toBe(second.taskPath)
  expect(await readFile(first.taskPath, 'utf8')).toBe('from one, fixed')
  expect((await readdir(task)).filter(name => name.startsWith('report')).sort()).toEqual(['report (2).md', 'report.md'])

  // Inline inputs (a workbook's rows, a page's html): another input in the same turn is another file; in a later turn it is the fix of that file.
  const real = await (await import('node:fs/promises')).realpath(task), record = twinsFile(paths, real)
  const place = (data: string, source: string, turn?: string) => placeInTask(real, 'a.xlsx', Buffer.from(data), record, { source, turn })
  expect(await place('v1', 'rows 1', 't1')).toBe(join(real, 'a.xlsx'))
  expect(await place('other', 'rows 2', 't1')).toBe(join(real, 'a (2).xlsx'))
  expect(await place('v2', 'rows 3', 't2')).toBe(join(real, 'a.xlsx'))
  expect(await readFile(join(real, 'a (2).xlsx'), 'utf8')).toBe('other')
  // With no turn named, only the same source is the same deliverable.
  expect(await place('v3', 'rows 4')).toBe(join(real, 'a (3).xlsx'))
  expect(await place('v4', 'rows 3')).toBe(join(real, 'a.xlsx'))
})
