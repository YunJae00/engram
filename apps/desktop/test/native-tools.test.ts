import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { vaultPaths } from 'core'

vi.mock('electron', () => ({ app: { getPath: (name: string) => join('C:/home', name) } }))
import { cometNativeTools, mentionedOutputs, nativeDecision, nativeSummary, type NativePolicy } from '../src/main/native-tools.js'

let root: string, cwd: string, documents: string, cache: string, privateDir: string
const policy = (ask?: NativePolicy['ask']): NativePolicy => ({ cwd, roots: [cwd, join(cache, 'artifacts'), documents], cacheDir: cache, privateDir, commands: { allowed: false }, ...(ask ? { ask } : {}) })
beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  root = await mkdtemp(resolve('tmp/native-tools-'))
  documents = join(root, 'documents'); cache = join(documents, 'vault', '.engram'); cwd = join(cache, 'work', 'bot-1'); privateDir = join(documents, 'vault', 'private')
  await Promise.all([cwd, privateDir, join(cache, 'artifacts'), join(cache, 'chat-attachments'), join(root, 'outside')].map(path => mkdir(path, { recursive: true })))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('native tool policy', () => {
  it('reads where the person already lets the comet look, and nowhere else', async () => {
    expect((await nativeDecision(policy(), 'Read', { file_path: join(documents, 'report.xlsx') })).behavior).toBe('allow')
    expect((await nativeDecision(policy(), 'Grep', { pattern: 'total' })).behavior).toBe('allow')
    expect((await nativeDecision(policy(), 'Read', { file_path: 'notes.txt' })).behavior).toBe('allow')
    expect((await nativeDecision(policy(), 'Read', { file_path: join(privateDir, 'secret.md') })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Read', { file_path: join(documents, '..', 'other', 'x.txt') })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Read', { file_path: join(root, 'outside', 'x.txt') })).message).toContain('attach')
  })

  it('writes only in the work folder and points deliverables at the file tools', async () => {
    expect((await nativeDecision(policy(), 'Write', { file_path: 'parse.py', content: '' })).behavior).toBe('allow')
    expect((await nativeDecision(policy(), 'Edit', { file_path: `${cwd}/parse.py` })).behavior).toBe('allow')
    const outside = await nativeDecision(policy(), 'Write', { file_path: join(documents, 'out.md'), content: '' })
    expect(outside.behavior).toBe('deny')
    expect(outside.message).toContain('file_create_copy')
  })

  it('runs commands once the person has said yes for this comet, and waits otherwise', async () => {
    const verdicts: string[] = []
    const ask = vi.fn(async ({ words }: { words: string }) => { verdicts.push(words); return 'later' as const })
    const p = policy(ask)
    expect((await nativeDecision(p, 'Bash', { command: 'python parse.py' })).message).toContain('waits')
    expect(verdicts[0]).toContain('not sandboxed')
    expect(verdicts[0]!.length).toBeLessThanOrEqual(120)
    ask.mockResolvedValueOnce('approve')
    expect((await nativeDecision(p, 'Bash', { command: 'python parse.py' })).behavior).toBe('allow')
    expect((await nativeDecision(p, 'Bash', { command: 'python summarize.py' })).behavior).toBe('allow')
    expect((await nativeDecision(p, 'PowerShell', { command: 'python summarize.py' })).behavior).toBe('allow')
    expect(ask).toHaveBeenCalledTimes(2)
    expect((await nativeDecision(policy(), 'Bash', { command: 'ls' })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Bash', { command: ' ' })).behavior).toBe('deny')
  })

  it('leaves questions to ask_person and refuses unknown tools', async () => {
    expect((await nativeDecision(policy(), 'AskUserQuestion', {})).message).toContain('ask_person')
    expect((await nativeDecision(policy(), 'WebFetch', { url: 'http://127.0.0.1/admin' })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'WebSearch', { query: 'search' })).message).toContain('Engram\'s web tools')
    expect((await nativeDecision(policy(), 'Mystery', {})).behavior).toBe('deny')
    for (const name of ['Agent', 'Task', 'Skill', 'ToolSearch']) expect((await nativeDecision(policy(), name, {})).behavior).toBe('deny')
  })

  it('summarises a call in one line', () => {
    expect(nativeSummary('Bash', { command: 'python  parse.py\n--all' })).toBe('python parse.py --all')
    expect(nativeSummary('Read', { file_path: 'C:/x.md' })).toBe('C:/x.md')
    expect(nativeSummary('Grep', { pattern: 'tot' })).toBe('tot')
    expect(nativeSummary('TodoWrite', {})).toBe('')
  })

  it('does not let missing paths, conflicting fields or glob patterns widen a read', async () => {
    for (const file_path of [undefined, null, 0, '', 'secret.txt\0', 'secret.txt:stream']) expect((await nativeDecision(policy(), 'Read', { file_path })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Grep', { file_path: join(cwd, 'safe'), path: join(root, 'outside'), pattern: 'secret' })).behavior).toBe('deny')
    for (const pattern of ['../*', '/etc/*', 'C:/Windows/*', '{ok,../../*}']) expect((await nativeDecision(policy(), 'Glob', { pattern })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Glob', { pattern: '**/*.txt' })).behavior).toBe('allow')
  })

  it('refuses a linked read or new write whose real parent is outside the work folder', async () => {
    await symlink(join(root, 'outside'), join(cwd, 'linked'), 'junction')
    expect((await nativeDecision(policy(), 'Read', { file_path: 'linked/secret.txt' })).behavior).toBe('deny')
    expect((await nativeDecision(policy(), 'Write', { file_path: 'linked/new/note.txt', content: 'x' })).behavior).toBe('deny')
    await symlink(privateDir, join(documents, 'linked-private'), 'junction')
    expect((await nativeDecision(policy(), 'Read', { file_path: join(documents, 'linked-private', 'secret.txt') })).behavior).toBe('deny')
  })

  it('reads only supplied attachments and refuses broad searches covering private or other chat data', async () => {
    const p = policy()
    p.attachedPaths = [join(cache, 'chat-attachments', 'mine.txt')]
    expect((await nativeDecision(p, 'Read', { file_path: p.attachedPaths[0] })).behavior).toBe('allow')
    expect((await nativeDecision(p, 'Read', { file_path: join(cache, 'chat-attachments', 'other.txt') })).behavior).toBe('deny')
    expect((await nativeDecision(p, 'Read', { file_path: join(cache, 'work', 'other', 'secret.txt') })).behavior).toBe('deny')
    expect((await nativeDecision(p, 'Grep', { path: documents, pattern: 'secret' })).behavior).toBe('deny')
    expect((await nativeDecision(p, 'Grep', { path: cwd, pattern: 'total' })).behavior).toBe('allow')
  })

  it('does not store a command approval after the call was canceled', async () => {
    const abort = new AbortController()
    const p = policy(async () => { abort.abort(); return 'approve' })
    expect((await nativeDecision(p, 'Bash', { command: 'python parse.py' }, abort.signal)).behavior).toBe('deny')
    expect(p.commands.allowed).toBe(false)
  })

  it('keeps command consent separate for two workspaces with the same comet identifier', async () => {
    const ask = vi.fn(async () => 'approve' as const)
    const options = { channel: 'same-chat', ask, onStep: vi.fn(), audit: vi.fn() }
    const one = await cometNativeTools({ ...options, paths: vaultPaths(join(root, 'one')) })
    const two = await cometNativeTools({ ...options, paths: vaultPaths(join(root, 'two')) })
    const signal = new AbortController().signal
    expect((await one.decide('Bash', { command: 'echo one' }, signal)).behavior).toBe('allow')
    expect((await two.decide('Bash', { command: 'echo two' }, signal)).behavior).toBe('allow')
    expect(ask).toHaveBeenCalledTimes(2)
  })
})

describe('outputs left in the task folder', () => {
  it('hands in only deliverables built this turn and named in the answer, not scripts or ones already linked', async () => {
    const since = Date.now() - 1000
    await mkdir(join(cwd, 'out'), { recursive: true })
    for (const name of ['report(2026.10.11.).xlsx', 'parse.py', 'notes.md', 'linked.csv']) await writeFile(join(cwd, name), 'x')
    await writeFile(join(cwd, 'out', 'summary.md'), 'x')
    await writeFile(join(cwd, 'old.csv'), 'x')
    await utimes(join(cwd, 'old.csv'), new Date(since - 60_000), new Date(since - 60_000))
    const answer = 'Built `C:\\work\\report(2026.10.11.).xlsx`, ran parse.py, wrote out/summary.md and old.csv. [linked.csv](engram-artifact:abc-linked.csv)'
    const found = (await mentionedOutputs(cwd, answer, since)).map(path => path.slice(cwd.length + 1).replace(/\\/g, '/')).sort()
    expect(found).toEqual(['out/summary.md', 'report(2026.10.11.).xlsx'])
    expect(await mentionedOutputs(join(root, 'missing'), answer, since)).toEqual([])
  })
})
