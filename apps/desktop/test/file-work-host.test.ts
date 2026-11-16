import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { vaultPaths } from '../../../packages/core/src/vault.js'

// Reads outside the usual folders are asked in the chat (state.ask), never with an app-modal dialog (state.dialog).
const state = vi.hoisted(() => ({ stopped: false, confirm: vi.fn(), dialog: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: state.getPath }, dialog: { showMessageBox: state.dialog }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: { showItemInFolder: vi.fn() } }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => { if (state.stopped) throw new Error('Stopped for this turn') } }))
import { pathToFileURL } from 'node:url'
import { cometFileTools as hostFileTools, placeInTask, previousVersions, taskOutputs, twinsFile } from '../src/main/file-work.js'

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

// qa145 r3: two workbooks share a name; remaking the second in a later turn replaced the first one's "a.xlsx" before reaching its own "a (2).xlsx".
it('a later-turn remake replaces the copy made from its own source, not another deliverable holding the plain name', async () => {
  const paths = vaultPaths(root), task = join(root, 'workspace', 'tasks', 'lane')
  await mkdir(task, { recursive: true })
  const real = await (await import('node:fs/promises')).realpath(task), record = twinsFile(paths, real)
  const place = (data: string, source: string, turn: string) => placeInTask(real, 'a.xlsx', Buffer.from(data), record, { source, turn })
  expect(await place('first', 'book 1', 't1')).toBe(join(real, 'a.xlsx'))
  expect(await place('second', 'book 2', 't1')).toBe(join(real, 'a (2).xlsx'))
  expect(await place('second, fixed', 'book 2', 't2')).toBe(join(real, 'a (2).xlsx'))
  expect(await readFile(join(real, 'a.xlsx'), 'utf8')).toBe('first')
  expect(await readFile(join(real, 'a (2).xlsx'), 'utf8')).toBe('second, fixed')
  // Its own copy changed by hand since: the remake is numbered, and still does not take the other deliverable's file.
  await writeFile(join(real, 'a (2).xlsx'), 'edited by hand')
  expect(await place('second, again', 'book 2', 't3')).toBe(join(real, 'a (3).xlsx'))
  expect(await readFile(join(real, 'a.xlsx'), 'utf8')).toBe('first')
  expect((await readdir(real)).sort()).toEqual(['a (2).xlsx', 'a (3).xlsx', 'a.xlsx'])
})

// qa146 2a: the "(이전)" link was guessed from a repeated file name in the chat, so two tasks that each made plan.md were linked.
it('records the earlier version only where a task file is replaced in place, and offers it only while it still exists', async () => {
  const paths = vaultPaths(root)
  const save = (lane: string, turn: string, text: string) => taskOutputs(paths, async () => join(root, 'workspace', 'tasks', lane), undefined, turn).save('plan.md', Buffer.from(text)) as Promise<{ artifact: string; path: string; taskPath: string }>
  const a = await save('task-a', 't1', 'plan of task A'), b = await save('task-b', 't2', 'plan of task B')
  expect(b.taskPath).not.toBe(a.taskPath)
  expect(await previousVersions(paths, b.artifact)).toEqual([])
  // Task A's plan made again in later turns: each replaces the task file in place, and the versions before it are on record, nearest first.
  const a2 = await save('task-a', 't3', 'plan of task A, fixed'), a3 = await save('task-a', 't4', 'plan of task A, fixed again')
  expect(a3.taskPath).toBe(a.taskPath)
  expect(await previousVersions(paths, a3.artifact)).toEqual([a2.artifact, a.artifact])
  expect(await previousVersions(paths, a.artifact)).toEqual([])
  expect(await previousVersions(paths, b.artifact)).toEqual([])
  // A version whose saved output is gone is not offered.
  await rm(a2.path)
  expect(await previousVersions(paths, a3.artifact)).toEqual([a.artifact])
})

// grokbar D1/F1: what the person names inside their own workspace is read and moved without a card; Engram's own store and anything outside still ask or refuse.
it('reads a file the person named in their workspace without asking, in their own chat only', async () => {
  const paths = vaultPaths(root), task = join(paths.workspace, 'tasks', 'bot-1')
  await mkdir(join(paths.workspace, 'fixtures'), { recursive: true })
  await mkdir(paths.cache, { recursive: true })
  const named = join(paths.workspace, 'fixtures', 'meeting-notes.md'), store = join(paths.cache, 'bots.json')
  await writeFile(named, '# 회의록')
  await writeFile(store, '{}')
  const read = cometFileTools(paths, 'lane', [], [task]).find(tool => tool.name === 'file_read')!
  expect(JSON.parse(await read.run({ path: named }, { task: 'Summarize it.' })).content).toBe('# 회의록')
  expect(state.confirm).not.toHaveBeenCalled()
  await read.run({ path: store }, { task: 'Read it.' })
  expect(state.confirm).toHaveBeenCalledOnce()
  // A chat with no task folder (an outside connection) keeps the card.
  await cometFileTools(paths, 'lane').find(tool => tool.name === 'file_read')!.run({ path: named }, { task: 'Summarize it.' })
  expect(state.confirm).toHaveBeenCalledTimes(2)
  expect(hostFileTools(paths, 'lane').some(tool => tool.name === 'file_move')).toBe(false)
})

it('moves the person\'s files inside the workspace without asking, and never overwrites, deletes or leaves it', async () => {
  const paths = vaultPaths(root), task = join(paths.workspace, 'tasks', 'bot-1'), dump = join(paths.workspace, 'fixtures', 'inbox-dump')
  await mkdir(dump, { recursive: true })
  for (const folder of [paths.notes, paths.cache, join(root, 'outside')]) await mkdir(folder, { recursive: true })
  for (const name of ['a.pdf', 'b.pdf', 'c.docx']) await writeFile(join(dump, name), name)
  await writeFile(join(paths.notes, 'n.md'), 'note')
  await writeFile(join(root, 'outside', 'o.txt'), 'out')
  const move = cometFileTools(paths, 'lane', [], [task]).find(tool => tool.name === 'file_move')!
  const run = (moves: { from: string; to: string }[]) => move.run({ moves }, { task: 'Sort the folder by type.' })
  const receipt = JSON.parse(await run([{ from: 'fixtures/inbox-dump/a.pdf', to: 'fixtures/inbox-dump/PDF/a.pdf' }, { from: join(dump, 'b.pdf'), to: join(dump, 'PDF', 'b.pdf') }, { from: 'fixtures/inbox-dump/c.docx', to: 'fixtures/inbox-dump/Word/c.docx' }]))
  expect(receipt).toEqual({ moved: 3, overwritten: 0, deleted: 0, folders: [{ folder: 'fixtures/inbox-dump/PDF', count: 2, files: ['a.pdf', 'b.pdf'] }, { folder: 'fixtures/inbox-dump/Word', count: 1, files: ['c.docx'] }] })
  expect((await readdir(dump)).sort()).toEqual(['PDF', 'Word'])
  expect(await readFile(join(dump, 'PDF', 'b.pdf'), 'utf8')).toBe('b.pdf')
  expect(state.confirm).not.toHaveBeenCalled()
  // One target that exists stops the whole batch: the first move is not made either.
  await writeFile(join(dump, 'd.pdf'), 'new d')
  await expect(run([{ from: 'fixtures/inbox-dump/PDF/a.pdf', to: 'fixtures/inbox-dump/a.pdf' }, { from: 'fixtures/inbox-dump/d.pdf', to: 'fixtures/inbox-dump/PDF/b.pdf' }])).rejects.toThrow('already exists')
  expect((await readdir(join(dump, 'PDF'))).sort()).toEqual(['a.pdf', 'b.pdf'])
  expect(await readFile(join(dump, 'PDF', 'b.pdf'), 'utf8')).toBe('b.pdf')
  // Engram's folders, the private vault and anything outside the workspace are neither a source nor a target.
  for (const [from, to] of [['notes/n.md', 'fixtures/n.md'], ['fixtures/inbox-dump/d.pdf', '.engram/d.pdf'], ['fixtures/inbox-dump/d.pdf', '../outside/d.pdf'], [join(root, 'outside', 'o.txt'), 'fixtures/o.txt'], ['fixtures/inbox-dump/d.pdf', join(root, 'private', 'd.pdf')], ['tasks', 'fixtures/tasks'], ['fixtures', 'fixtures/inbox-dump/PDF/fixtures']])
    await expect(run([{ from: from!, to: to! }])).rejects.toThrow()
  expect(await readFile(join(paths.notes, 'n.md'), 'utf8')).toBe('note')
  expect(await readFile(join(dump, 'd.pdf'), 'utf8')).toBe('new d')
  // A source that cannot be removed is not left in both places (r1: the link stayed while the answer said nothing was moved).
  // Folder permissions do not stop an unlink on Windows, so this part runs elsewhere.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(paths.workspace, 'fixtures', 'locked')
    await mkdir(locked)
    await writeFile(join(locked, 'k.txt'), 'k')
    await chmod(locked, 0o555)
    try {
      await expect(run([{ from: 'fixtures/inbox-dump/d.pdf', to: 'fixtures/kept/d.pdf' }, { from: 'fixtures/locked/k.txt', to: 'fixtures/kept/k.txt' }])).rejects.toThrow('Nothing was moved')
    } finally { await chmod(locked, 0o755) }
    expect(await readdir(join(paths.workspace, 'fixtures', 'kept'))).toEqual([])
    expect(await readFile(join(locked, 'k.txt'), 'utf8')).toBe('k')
    expect(await readFile(join(dump, 'd.pdf'), 'utf8')).toBe('new d')
  }
  // A move that is whole says so itself: its receipt is read from the disk after the move.
  const seen = vi.fn()
  await move.run({ moves: [{ from: 'fixtures/inbox-dump/d.pdf', to: 'fixtures/inbox-dump/d2.pdf' }] }, { task: 'Rename it.', onObservedAfterAction: seen })
  expect(seen).toHaveBeenCalledTimes(1)
  await move.run({ moves: [{ from: 'fixtures/inbox-dump/d2.pdf', to: 'fixtures/inbox-dump/d.pdf' }] }, { task: 'Rename it back.' })
  // A folder moves whole, and back.
  await run([{ from: 'fixtures/inbox-dump/PDF', to: 'fixtures/inbox-dump/문서/PDF' }])
  expect((await readdir(join(dump, '문서', 'PDF'))).sort()).toEqual(['a.pdf', 'b.pdf'])
  state.stopped = true
  await expect(run([{ from: 'fixtures/inbox-dump/d.pdf', to: 'fixtures/inbox-dump/e.pdf' }])).rejects.toThrow('Stopped')
})

it.skipIf(process.platform === 'win32')('does not move through a link that leads out of the workspace', async () => {
  const paths = vaultPaths(root), task = join(paths.workspace, 'tasks', 'bot-1')
  await mkdir(join(paths.workspace, 'fixtures'), { recursive: true })
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'o.txt'), 'out')
  await writeFile(join(paths.workspace, 'fixtures', 'in.txt'), 'in')
  await symlink(join(root, 'outside'), join(paths.workspace, 'fixtures', 'door'))
  const move = cometFileTools(paths, 'lane', [], [task]).find(tool => tool.name === 'file_move')!
  await expect(move.run({ moves: [{ from: 'fixtures/in.txt', to: 'fixtures/door/in.txt' }] }, { task: 'Move it.' })).rejects.toThrow('Only the person')
  await expect(move.run({ moves: [{ from: 'fixtures/door/o.txt', to: 'fixtures/o.txt' }] }, { task: 'Move it.' })).rejects.toThrow('Only the person')
  // The link itself is neither a file nor a folder of theirs.
  await expect(move.run({ moves: [{ from: 'fixtures/door', to: 'fixtures/door2' }] }, { task: 'Move it.' })).rejects.toThrow('Not a file or folder')
  expect(await readFile(join(root, 'outside', 'o.txt'), 'utf8')).toBe('out')
})

// grokbar D5: "방금 만든 PPT 3번 슬라이드 제목 바꿔줘" asked whether to make a copy. A composed file (ppt_build, word_write) changed in a later
// turn under its own name is the same file in the task folder, with no question and no numbered twin.
it('a later turn changes a composed file in place in the task folder, under its own name, without asking', async () => {
  const paths = vaultPaths(root), task = join(paths.workspace, 'tasks', 'bot-1')
  // Composed files are handed in through taskOutputs, as ppt_build and word_write do; the bytes here are a workbook the file tools can open.
  const draft = JSON.parse(await hostFileTools(paths, 'lane', [], [join(paths.workspace, 'tasks', 'bot-0')], { ask: state.confirm, turn: 't0' }).find(tool => tool.name === 'file_create_workbook')!.run({ name: 'draft.xlsx', sheet: 'S', rows: [['title'], [41]] }, { task: 'Make it.' })) as { path: string }
  const first = await taskOutputs(paths, async () => task, new Set<string>(), 't1').save('deck.xlsx', await readFile(draft.path)) as { path: string; taskPath: string }
  const tools = hostFileTools(paths, 'lane', [first.path], [task], { ask: state.confirm, turn: 't2' })
  const use = async (name: string, args: Record<string, unknown>) => JSON.parse(await tools.find(tool => tool.name === name)!.run(args, { task: 'Change the number to 42.' }))
  const part = await use('file_read_package', { path: first.taskPath, part: 'xl/worksheets/sheet1.xml' })
  const edited = await use('file_edit_package', { sourcePath: first.taskPath, expectedSha256: part.sha256, name: 'deck.xlsx', edits: [{ part: part.part, expectedSha256: part.partSha256, before: '<v>41</v>', after: '<v>42</v>' }] })
  expect(edited.taskPath).toBe(first.taskPath)
  expect(await readdir(task)).toEqual(['deck.xlsx'])
  expect((await use('file_read_package', { path: first.taskPath, part: 'xl/worksheets/sheet1.xml' })).xml).toContain('<v>42</v>')
  // The file itself was changed, so it is still one file: the earlier bytes are not kept as a second deck in the saved outputs
  // (grokbar D5 r1: the harness counts every .pptx in the workspace, and found two).
  const saved = async () => (await readdir(dirname(first.path))).filter(file => file.endsWith('deck.xlsx'))
  expect(await saved()).toEqual([edited.artifact])
  expect(await previousVersions(paths, edited.artifact)).toEqual([])
  // Changed again in the next turn, through the saved output's own path: still one.
  const later = hostFileTools(paths, 'lane', [edited.path], [task], { ask: state.confirm, turn: 't3' })
  const next = async (name: string, args: Record<string, unknown>) => JSON.parse(await later.find(tool => tool.name === name)!.run(args, { task: 'Change the number to 43.' }))
  const again = await next('file_read_package', { path: edited.path, part: 'xl/worksheets/sheet1.xml' })
  const third = await next('file_edit_package', { sourcePath: edited.path, expectedSha256: again.sha256, name: 'deck.xlsx', edits: [{ part: again.part, expectedSha256: again.partSha256, before: '<v>42</v>', after: '<v>43</v>' }] })
  expect(third.taskPath).toBe(first.taskPath)
  expect(await saved()).toEqual([third.artifact])
  expect(state.confirm).not.toHaveBeenCalled()
})

it('an earlier version another chat\'s task folder also holds is not removed by a change here', async () => {
  const paths = vaultPaths(root), task = join(paths.workspace, 'tasks', 'bot-1'), other = join(paths.workspace, 'tasks', 'bot-2')
  const draft = JSON.parse(await hostFileTools(paths, 'lane', [], [join(paths.workspace, 'tasks', 'bot-0')], { ask: state.confirm, turn: 't0' }).find(tool => tool.name === 'file_create_workbook')!.run({ name: 'deck.xlsx', sheet: 'S', rows: [['title'], [41]] }, { task: 'Make it.' })) as { path: string }
  const data = await readFile(draft.path)
  const first = await taskOutputs(paths, async () => task, new Set<string>(), 't1').save('deck.xlsx', data) as { path: string; taskPath: string; artifact: string }
  await taskOutputs(paths, async () => other, new Set<string>(), 't1').save('deck.xlsx', data)
  const tools = hostFileTools(paths, 'lane', [first.path], [task], { ask: state.confirm, turn: 't2' })
  const use = async (name: string, args: Record<string, unknown>) => JSON.parse(await tools.find(tool => tool.name === name)!.run(args, { task: 'Change the number to 42.' }))
  const part = await use('file_read_package', { path: first.taskPath, part: 'xl/worksheets/sheet1.xml' })
  const edited = await use('file_edit_package', { sourcePath: first.taskPath, expectedSha256: part.sha256, name: 'deck.xlsx', edits: [{ part: part.part, expectedSha256: part.partSha256, before: '<v>41</v>', after: '<v>42</v>' }] })
  expect(await previousVersions(paths, edited.artifact)).toEqual([first.artifact])
  expect((await readFile(first.path)).equals(data)).toBe(true)
})
