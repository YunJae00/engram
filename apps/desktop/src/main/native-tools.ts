import { app } from 'electron'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, type NativeDecision, type NativeTools, type VaultPaths } from 'core'
import type { Ask } from './page-actions.js'
import { artifactDirectory } from './file-work.js'

const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell', 'Shell'])
const FREE = new Set(['TodoWrite', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate'])
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel))
}
const deny = (message: string): NativeDecision => ({ behavior: 'deny', message })
const allow: NativeDecision = { behavior: 'allow' }

export interface NativePolicy {
  cwd: string
  roots: string[]
  privateDir: string
  cacheDir?: string
  attachedPaths?: string[]
  commands: { allowed: boolean }
  ask?: Ask
}

export function nativeSummary(name: string, input: Record<string, unknown>): string {
  const value = SHELLS.has(name) ? input['command'] : name === 'Grep' || name === 'Glob' ? input['pattern'] : name === 'WebFetch' || name === 'WebSearch' ? input['url'] ?? input['query'] : input['file_path'] ?? input['path'] ?? input['notebook_path'] ?? input['description']
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
}

// New files still inherit the real location of their closest existing parent.
async function actualPath(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return resolve(await actualPath(dirname(path)), relative(dirname(path), path))
  }
}

export async function nativeDecision(policy: NativePolicy, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<NativeDecision> {
  if (signal?.aborted) return deny('The call was canceled.')
  if (READS.has(name) || WRITES.has(name)) {
    const search = ['Glob', 'Grep', 'LS'].includes(name)
    const key = search ? 'path' : name.startsWith('Notebook') ? 'notebook_path' : 'file_path'
    const target = input[key] === undefined && search ? policy.cwd : input[key]
    if (typeof target !== 'string' || !target.trim() || target.includes('\0') || /:(?![\\/])/.test(target)) return deny('Supply a valid file path.')
    if (name === 'Glob' && (typeof input['pattern'] !== 'string' || /(^[\\/~]|:|\0|\.\.)/.test(input['pattern']))) return deny('Use a relative glob pattern without parent paths, and set path to an allowed folder.')
    try {
      const path = await actualPath(resolve(policy.cwd, target))
      const cwd = await actualPath(policy.cwd)
      if (WRITES.has(name)) return within(cwd, path)
        ? { behavior: 'allow', updatedInput: { ...input, [key]: path } }
        : deny(`Write and Edit work only inside the task folder ${policy.cwd}. Save deliverables with file_create_copy or file_create_workbook so they are linked and checked.`)
      const privateDir = await actualPath(policy.privateDir)
      const roots = await Promise.all(policy.roots.map(actualPath))
      const cache = policy.cacheDir ? await actualPath(policy.cacheDir) : undefined
      const attached = await Promise.all((policy.attachedPaths ?? []).map(actualPath))
      const inRoot = roots.some(root => within(root, path) && (!cache || !within(cache, path) || within(cache, root)))
      const protectedSearch = search && (within(path, privateDir) || (cache && within(path, cache)))
      if (!within(privateDir, path) && !protectedSearch && (inRoot || attached.includes(path))) return { behavior: 'allow', updatedInput: { ...input, [key]: path } }
    } catch { return deny('The file location could not be verified.') }
    return deny('Only files in the task folder, this chat\'s attachments, saved outputs, Documents, Desktop and Downloads can be read directly. Search a narrower folder or ask the person to attach anything else.')
  }
  if (SHELLS.has(name)) {
    const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
    if (!command) return deny('Supply a command.')
    if (policy.commands.allowed) return allow
    if (!policy.ask) return deny('Commands are not available in this chat.')
    const verdict = await policy.ask({ words: 'Allow commands for this comet? They can read or change any accessible file and use the network; not sandboxed.', url: pathToFileURL(policy.cwd).href })
    if (signal?.aborted) return deny('The call was canceled.')
    if (verdict === 'approve' || verdict === 'always') { policy.commands.allowed = true; return allow }
    if (verdict === 'later') return deny('Running commands waits for the person\'s approval. Continue with other work, or report what remains.')
    return deny('The person did not allow commands for this comet.')
  }
  if (FREE.has(name)) return allow
  if (name === 'AskUserQuestion') return deny('Ask with ask_person instead.')
  if (name === 'WebFetch' || name === 'WebSearch') return deny('Use Engram\'s web tools so its connection and approval checks still apply.')
  return deny(`${name} is not available in this chat.`)
}

const DELIVERABLES = new Set(['.xlsx', '.docx', '.pptx', '.csv', '.tsv', '.md', '.txt', '.json'])

// A file the comet built in its task folder this turn and named in its answer,
// but never handed in: the person was told about it, so it becomes an output.
export async function mentionedOutputs(cwd: string, answer: string, since: number): Promise<string[]> {
  const entries = await readdir(cwd, { recursive: true }).catch(() => [] as string[])
  const found: string[] = []
  for (const entry of entries) {
    const path = join(cwd, entry), name = basename(entry)
    if (!DELIVERABLES.has(extname(name).toLowerCase()) || !answer.includes(name)) continue
    if (answer.includes(`-${artifactHref(name)})`) || answer.includes(`-${encodeURIComponent(name)})`)) continue
    const info = await stat(path).catch(() => null)
    if (info?.isFile() && info.mtimeMs >= since) found.push(path)
  }
  return found
}

const consent = new Map<string, { allowed: boolean }>()

export async function cometNativeTools(options: { paths: VaultPaths; channel: string; attachedPaths?: string[]; ask?: Ask; onStep(line: string): void; audit(tool: string, detail: string): void }): Promise<NativeTools> {
  const cwd = join(options.paths.cache, 'work', options.channel.replace(/[^A-Za-z0-9_-]+/g, '-'))
  await mkdir(cwd, { recursive: true })
  const roots = [cwd, artifactDirectory(options.paths), ...(['documents', 'desktop', 'downloads'] as const).map((name) => app.getPath(name))]
  const consentKey = await realpath(cwd)
  let commands = consent.get(consentKey)
  if (!commands) consent.set(consentKey, commands = { allowed: false })
  const policy: NativePolicy = { cwd, roots, privateDir: options.paths.privateDir, cacheDir: options.paths.cache, attachedPaths: options.attachedPaths ?? [], commands, ...(options.ask ? { ask: options.ask } : {}) }
  return {
    cwd,
    readRoots: roots,
    decide: (name, input, signal) => nativeDecision(policy, name, input, signal),
    onCall(name, input) {
      const line = nativeSummary(name, input)
      options.onStep(`${name}: ${line}`)
      options.audit(name, line)
    },
  }
}
