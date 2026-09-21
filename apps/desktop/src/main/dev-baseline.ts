import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { changeHunks, renameWithRetry } from 'core'
import type { DevFileReview, DevGitState } from '../shared/developers.js'
import { devEditPreview, devLocalPath } from './dev-edit.js'
import { runDevGit } from './dev-workspace.js'

interface Baseline { cwd: string; at: number; limited: boolean; complete: boolean; files: Record<string, string | null> }
const file = (root: string, id: string) => join(root, 'task-baselines', `${createHash('sha256').update(id).digest('hex')}.json`)
const digest = (before: string, after: string) => createHash('sha256').update(before).update('\0').update(after).digest('hex')
const capturing = new Map<string, Promise<void>>()

function* serialize({ files, ...metadata }: Baseline): Generator<string> {
  yield `${JSON.stringify(metadata).slice(0, -1)},"files":{`
  let first = true
  for (const [path, content] of Object.entries(files)) {
    yield `${first ? '' : ','}${JSON.stringify(path)}:${JSON.stringify(content)}`
    first = false
  }
  yield '}}'
}

async function paths(cwd: string, hooks: string): Promise<{ files: string[]; limited: boolean }> {
  try {
    const output = await runDevGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], hooks)
    const files = [...new Set(output.split('\0').filter(Boolean))]
    return { files: files.slice(0, 5000), limited: files.length > 5000 }
  } catch (error) {
    if (!(error instanceof Error) || !/not a git repository/i.test(error.message)) throw error
    const files: string[] = [], folders = ['']
    let visited = 0
    while (folders.length && files.length < 5000) {
      const folder = folders.shift()!
      for await (const entry of await opendir(join(cwd, folder))) {
        if (++visited > 10_000) return { files, limited: true }
        const path = folder ? `${folder}/${entry.name}` : entry.name
        if (['node_modules', '.git', '.engram', 'dist', 'out', 'build', 'coverage', 'vendor'].includes(entry.name)) continue
        if (entry.isDirectory() && await devLocalPath(cwd, path)) folders.push(path)
        else files.push(path)
        if (files.length >= 5000) return { files, limited: true }
      }
    }
    return { files, limited: folders.length > 0 }
  }
}

async function text(cwd: string, path: string): Promise<string | null> {
  try {
    const info = await lstat(resolve(cwd, path))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 500_000 || !await devLocalPath(cwd, path)) return null
    const buffer = await readFile(resolve(cwd, path))
    if (buffer.length > 500_000 || buffer.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch { return null }
}

async function load(root: string, id: string, cwd: string): Promise<Baseline> {
  const saved = JSON.parse(await readFile(file(root, id), 'utf8')) as Baseline
  if (saved.cwd !== cwd || !saved.files || typeof saved.files !== 'object' || Array.isArray(saved.files)) throw new Error('The task baseline is unavailable. No changes can be discarded.')
  return saved
}

export async function captureDevBaseline(root: string, id: string, cwd: string, hooks: string): Promise<void> {
  const key = file(root, id), existing = capturing.get(key)
  if (existing) return existing
  const pending = capture(root, id, cwd, hooks)
  capturing.set(key, pending)
  try { await pending } finally { capturing.delete(key) }
}

async function capture(root: string, id: string, cwd: string, hooks: string): Promise<void> {
  try { await load(root, id, cwd); return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const listing = await paths(cwd, hooks), files: Baseline['files'] = Object.create(null)
  let bytes = 0, limited = listing.limited
  // ponytail: bounded text checkpoints; larger/binary files remain explicit read-only exclusions.
  for (const path of listing.files) {
    const content = bytes < 20_000_000 ? await text(cwd, path) : null
    files[path] = content
    if (content !== null) bytes += Buffer.byteLength(content)
    else limited = true
  }
  const target = file(root, id)
  await mkdir(dirname(target), { recursive: true })
  const pending = `${target}.${randomUUID()}.tmp`
  try { await writeFile(pending, serialize({ cwd, at: Date.now(), limited, complete: !listing.limited, files }), { flag: 'wx', mode: 0o600 }); await renameWithRetry(pending, target) }
  finally { await rm(pending, { force: true }) }
}

export async function devTaskChanges(root: string, id: string, cwd: string, hooks: string): Promise<DevGitState> {
  let baseline: Baseline
  try { baseline = await load(root, id, cwd) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { branch: 'Task changes', files: [], diff: '', truncated: false, scope: 'task', warning: 'A task baseline is captured before its next message. Earlier changes are not attributed to this task.' } }
  const current = await paths(cwd, hooks), files: DevGitState['files'] = []
  for (const path of new Set([...Object.keys(baseline.files), ...current.files])) {
    const known = Object.hasOwn(baseline.files, path), before = known ? baseline.files[path] : !baseline.complete ? null : ''
    if (before === null) continue
    const exists = await lstat(resolve(cwd, path)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    const after = exists ? await text(cwd, path) : ''
    if (after === null || (known && exists && after === before) || (!known && !exists)) continue
    files.push({ path, status: !known ? ' A' : !exists ? ' D' : ' M' })
  }
  return { branch: 'Since this task started', files, diff: '', truncated: baseline.limited || current.limited, scope: 'task', warning: 'Compared with files before this task’s first message, including existing uncommitted edits. Later changes made by other apps in this folder cannot be distinguished from agent changes.' }
}

export async function devTaskFileReview(root: string, id: string, cwd: string, path: string): Promise<DevFileReview> {
  if (typeof path !== 'string') throw new Error('Choose a changed file.')
  const baseline = await load(root, id, cwd), known = Object.hasOwn(baseline.files, path)
  const before = known ? baseline.files[path] : !baseline.complete ? null : ''
  if (typeof before !== 'string') throw new Error('This file was excluded from the bounded task baseline. No automatic discard is available.')
  const preview = await devEditPreview(cwd, 'Write', { file_path: path, content: '' })
  if (!preview) throw new Error('This file cannot be reviewed safely inside the app.')
  const exists = await lstat(preview.path).then(info => info.isFile() && !info.isSymbolicLink(), () => false)
  const after = exists ? await text(cwd, path) : ''
  if (after === null) throw new Error('This file cannot be reviewed safely inside the app.')
  return { path, before, after, fingerprint: digest(before, after), readOnly: !exists || !known, scope: 'task', hunks: changeHunks(before, after) }
}
