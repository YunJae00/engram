import { app } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, fileWorkTools, renameWithRetry, type NativeDecision, type NativeTools, type PermissionMode, type TurnStep, type VaultPaths } from 'core'
import type { Ask } from './page-actions.js'
import { artifactDirectory, ensureTaskFolder, OUTPUT_BYTES, OUTPUT_EXTENSIONS, saveOutput, taskFile, taskRoot } from './file-work.js'
import { flog } from './flog.js'
import { latestResultOutputs } from './result-check.js'
import { noteScript } from './turn-scripts.js'

const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell', 'Shell'])
const FREE = new Set(['ToolSearch', 'TodoWrite', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate'])
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel))
}
const deny = (message: string): NativeDecision => ({ behavior: 'deny', message })
const PLAN_ONLY = 'Plan mode: commands and file changes are off. Read what you need, then reply with the plan.'
const allow: NativeDecision = { behavior: 'allow' }
const DECLINED = 'The person declined a command in this turn, so no command runs until they write again. Do not try another command. Finish with what you have, or ask the person one short plain-language question with ask_person.'

// Claude Code's own command sandbox needs nothing installed on macOS only; ENGRAM_CLAUDE_SANDBOX=0 is the dev switch back to cards.
export const commandSandbox = (engineId: string): boolean =>
  engineId === 'codex' || (engineId === 'claude' && process.platform === 'darwin' && process.env['ENGRAM_CLAUDE_SANDBOX'] !== '0')

export interface NativePolicy {
  cwd: string
  roots: string[]
  privateDir: string
  cacheDir?: string
  attachedPaths?: string[]
  commands: { allowed: boolean }
  sandboxed?: boolean
  // Unset is 'once': the first command asks, the rest follow.
  mode?: PermissionMode
  ask?: Ask
  // Per turn: a declined command card stops every later command in this turn without a card.
  declined?: boolean
  // Per turn: command cards are asked one at a time, so one answer covers the calls queued behind it.
  asking?: Promise<unknown>
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
      if (WRITES.has(name) && policy.mode === 'plan') return deny(PLAN_ONLY)
      if (WRITES.has(name)) return within(cwd, path)
        ? { behavior: 'allow', updatedInput: { ...input, [key]: path } }
        : deny(`Write and Edit work only inside the task folder ${policy.cwd}. Save deliverables with file_create_copy, file_create_workbook or render_file so they are linked and checked.`)
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
    if (policy.mode === 'plan') return deny(PLAN_ONLY)
    if (policy.declined) return deny(DECLINED)
    // A command that asks to leave the sandbox is never covered by the sandbox allowance or a one-time grant.
    const escaping = input['dangerouslyDisableSandbox'] === true
    const sandboxed = policy.sandboxed === true && !escaping
    const unbounded = (policy.mode === 'auto' && !sandboxed) || escaping
    const each = policy.mode === 'each' || unbounded
    if ((policy.mode === 'auto' && sandboxed) || (!each && policy.commands.allowed)) return allow
    const ask = policy.ask
    if (!ask) return deny('Commands are not available in this chat.')
    if (unbounded && command.length > 16_000) return deny('This command is too long to review. Use a smaller command.')
    const words = each ? `Run this command? ${command.replace(/\s+/g, ' ')}` : policy.sandboxed ? 'Allow commands for this comet? They can read files; writes stay in the task folder and network access is blocked.' : 'Allow commands for this comet? They can read or change any accessible file and use the network; not sandboxed.'
    // Bind approval to the exact command, not its shortened preview or working directory.
    const url = pathToFileURL(policy.cwd)
    if (unbounded) url.hash = createHash('sha256').update(command).digest('hex')
    const asked = (policy.asking ?? Promise.resolve()).then(() =>
      policy.declined ? 'cancel' as const
      : signal?.aborted ? undefined
      : !each && policy.commands.allowed ? 'approve' as const
      : ask({ words: unbounded ? `Run this command outside the sandbox?\n${command}` : words, url: url.href }))
    policy.asking = asked.catch(() => undefined)
    const verdict = await asked
    if (verdict === 'cancel') policy.declined = true
    if (signal?.aborted || verdict === undefined) return deny('The call was canceled.')
    if (verdict === 'approve' || verdict === 'always') { if (!each) policy.commands.allowed = true; return allow }
    if (verdict === 'later') return deny('Running commands waits for the person\'s approval. Continue with other work, or report what remains.')
    return deny(`${each ? 'The person did not allow this command.' : 'The person did not allow commands for this comet.'} ${DECLINED}`)
  }
  if (FREE.has(name)) return allow
  if (name === 'AskUserQuestion') return deny('Ask with ask_person instead.')
  if (name === 'WebFetch' || name === 'WebSearch') return deny('Use Engram\'s web tools so its connection and approval checks still apply.')
  return deny(`${name} is not available in this chat.`)
}

const linkedIds = (answer: string, name: string) => [...answer.matchAll(/\(engram-artifact:([^)\s]+)\)/g)].map(match => match[1]!).filter(href => href.endsWith(`-${artifactHref(name)}`) || href.endsWith(`-${encodeURIComponent(name)}`))
// A name the answer already links counts only when the task file changed since that hand-in.
async function handedIn(artifacts: string | undefined, answer: string, name: string, path: string): Promise<boolean> {
  if (!artifacts) return true
  const data = await readFile(path).catch(() => null)
  for (const id of linkedIds(answer, name)) if (data && (await readFile(join(artifacts, decodeURIComponent(id))).catch(() => null))?.equals(data)) return true
  return false
}

// A file the comet built in its task folder this turn and named in its answer,
// but never handed in: the person was told about it, so it becomes an output.
export async function mentionedOutputs(cwd: string, answer: string, since: number, oversized: string[] = [], artifacts?: string): Promise<string[]> {
  const entries = await readdir(cwd, { recursive: true }).catch(() => [] as string[])
  const found: string[] = []
  for (const entry of entries) {
    const path = join(cwd, entry), name = basename(entry)
    if (name.startsWith('.') || !OUTPUT_EXTENSIONS.has(extname(name).toLowerCase()) || !answer.includes(name)) continue
    // lstat: a link is never a deliverable.
    const info = await lstat(path).catch(() => null)
    // A file reached through a linked directory is outside the task folder.
    if (!info?.isFile() || !within(await realpath(cwd), await realpath(path))) continue
    // An oversized revision cannot match a saved output, so it still gets its size warning.
    if (linkedIds(answer, name).length && info.size <= OUTPUT_BYTES && await handedIn(artifacts, answer, name, path)) continue
    if (info.mtimeMs >= since) (info.size > OUTPUT_BYTES ? oversized : found).push(info.size > OUTPUT_BYTES ? name : path)
  }
  return found
}

const CORE_HAND_IN = /\.(xlsx|docx|pptx|csv|tsv|md|txt|json)$/i
// Every output of the turn reaches the answer as a file link: the ones a tool
// saved (even when the turn was cut short, since each was read back), and the
// raw files the answer names when the turn finished.
export async function deliverOutputs(paths: VaultPaths, cwd: string, result: { answer: string; steps: TurnStep[]; asked?: unknown; stopped?: unknown }, since: number, task: string, revisionsOnly = false): Promise<void> {
  if (result.asked) return
  const linked = (name: string) => result.answer.includes(`-${artifactHref(name)})`) || result.answer.includes(`-${encodeURIComponent(name)})`)
  for (const output of latestResultOutputs(result.steps, [])) {
    if (!linked(output.name)) result.answer = `${result.answer}\n\n[${output.name}](engram-artifact:${artifactHref(basename(output.path))})`
  }
  if (result.stopped) return
  const handIn = fileWorkTools({ directory: artifactDirectory(paths), approveRead: async () => false, handInRoots: [cwd] }).find((tool) => tool.name === 'file_create_copy')!
  const oversized: string[] = []
  for (const path of await mentionedOutputs(cwd, result.answer, since, oversized, artifactDirectory(paths))) {
    // A check turn's own scripts are its tools, not results; only a revised hand-in is delivered.
    if (revisionsOnly && !linkedIds(result.answer, basename(path)).length) continue
    try {
      const name = basename(path)
      const real = await taskFile(paths, cwd, path)
      const raw = async () => JSON.stringify(await saveOutput(artifactDirectory(paths), name, await readFile(real)))
      // Core reads text back under its own 8 MB limit; a larger file still goes in as made, up to the 50 MB cap.
      const observation = CORE_HAND_IN.test(name) ? await handIn.run({ name, fromPath: path }, { task }).catch(raw) : await raw()
      result.steps.push({ tool: 'file_create_copy', args: { name, fromPath: path }, observation })
      const link = (JSON.parse(observation) as { markdownLink: string }).markdownLink, stale = linkedIds(result.answer, name)
      // The revised file replaces the earlier hand-in where the answer quoted it.
      result.answer = stale.length ? stale.reduce((text, id) => text.replaceAll(`(engram-artifact:${id})`, link.slice(link.lastIndexOf('('))), result.answer) : `${result.answer}\n\n${link}`
    } catch (error) {
      flog('native-tools', `could not hand in ${path}: ${error instanceof Error ? error.message : String(error)}`)
      // The person was told about this file, so a failed hand-in is said, not dropped.
      result.answer = `${result.answer}\n\n⚠ ${basename(path)} could not be attached, so it stays in the task folder.`
    }
  }
  for (const name of oversized) result.answer = `${result.answer}\n\n⚠ ${name} is larger than 50 MB, so it stays in the task folder and is not attached.`
}

const consent = new Map<string, { allowed: boolean }>()

// Where a comet works: tasks/<taskId> in the person's workspace, one folder per
// conversation, unless one was assigned to it (a spare session's), which is
// remembered across restarts. Folders from before tasks/ existed stay in use.
const sanitized = (channel: string) => channel.replace(/[^A-Za-z0-9_-]+/g, '-')
const legacyRoot = (paths: VaultPaths) => join(paths.cache, 'work')
const claimsFile = (paths: VaultPaths) => join(paths.cache, 'work', 'claims.json')
async function readClaims(paths: VaultPaths): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(claimsFile(paths))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000) throw new Error('Invalid work-folder assignments.')
    const value: unknown = JSON.parse(await readFile(claimsFile(paths), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid work-folder assignments.')
    return value as Record<string, unknown>
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
function assignedFolder(paths: VaultPaths, folder: unknown): string {
  if (typeof folder !== 'string' || ![taskRoot(paths), legacyRoot(paths)].some(root => dirname(resolve(folder)) === resolve(root)) || !/^[A-Za-z0-9_-]+$/.test(basename(folder))) throw new Error('A comet work folder must stay inside this workspace.')
  return resolve(folder)
}
export async function workFolderFor(paths: VaultPaths, channel: string): Promise<string> {
  const claims = await readClaims(paths)
  const own = join(taskRoot(paths), sanitized(channel)), legacy = join(legacyRoot(paths), sanitized(channel))
  if (!Object.hasOwn(claims, channel)) return !(await lstat(own).catch(() => null)) && (await lstat(legacy).catch(() => null))?.isDirectory() ? legacy : own
  const folder = assignedFolder(paths, claims[channel])
  if (Object.entries(claims).some(([owner, value]) => owner !== channel && typeof value === 'string' && relative(folder, resolve(value)) === '')) throw new Error('This work folder is assigned to another comet.')
  return folder
}
let claimWrites: Promise<unknown> = Promise.resolve()
export function rememberWorkFolder(paths: VaultPaths, channel: string, folder: string): Promise<void> {
  const pending = claimWrites.then(async () => {
    const target = assignedFolder(paths, folder), claims = await readClaims(paths)
    if (Object.entries(claims).some(([owner, value]) => owner !== channel && typeof value === 'string' && relative(target, resolve(value)) === '')) throw new Error('This work folder is assigned to another comet.')
    if (claims[channel] === target || [taskRoot(paths), legacyRoot(paths)].some(root => target === resolve(join(root, sanitized(channel))))) return
    claims[channel] = target
    await mkdir(join(paths.cache, 'work'), { recursive: true })
    await writeFile(`${claimsFile(paths)}.tmp`, JSON.stringify(claims))
    await renameWithRetry(`${claimsFile(paths)}.tmp`, claimsFile(paths))
  })
  claimWrites = pending.catch(() => undefined)
  return pending
}

const spares = new Set<string>()
// Empty spare folders an earlier run left behind; anything with files or an owner stays.
async function pruneSpares(paths: VaultPaths): Promise<void> {
  const claimed = new Set(Object.values(await readClaims(paths).catch(() => ({}))).flatMap(value => typeof value === 'string' ? [resolve(value)] : []))
  for (const name of await readdir(taskRoot(paths)).catch(() => [] as string[])) {
    const folder = resolve(taskRoot(paths), name)
    if (name.startsWith('spare-') && !spares.has(folder) && !claimed.has(folder)) await rmdir(folder).catch(() => undefined)
  }
}

export async function cometNativeTools(options: { paths: VaultPaths; channel: string; cwd?: string; member?: string; sandboxed?: boolean; mode?: PermissionMode; attachedPaths?: string[]; ask?: Ask; onStep(line: string): void; audit(tool: string, detail: string): void }): Promise<NativeTools & { sandbox?: Record<string, unknown> }> {
  const lead = assignedFolder(options.paths, options.cwd ?? await workFolderFor(options.paths, options.channel))
  if (basename(lead).startsWith('spare-') && !spares.has(lead)) { await pruneSpares(options.paths); spares.add(lead) }
  await ensureTaskFolder(options.paths, lead)
  // A hired member works in a subfolder of the lead's task folder, so results can be combined.
  let cwd = lead
  if (options.member) {
    for (const part of ['team', sanitized(options.member)]) {
      cwd = join(cwd, part)
      await mkdir(cwd, { recursive: true })
      if ((await lstat(cwd)).isSymbolicLink() || !within(await realpath(lead), await realpath(cwd))) throw new Error('A member folder must stay inside its task folder.')
    }
  }
  const roots = [cwd, ...(cwd === lead ? [] : [lead]), artifactDirectory(options.paths), ...(['documents', 'desktop', 'downloads'] as const).map((name) => app.getPath(name))]
  const consentKey = `${await realpath(cwd)}:${options.sandboxed ? 'sandboxed' : 'full'}`
  let commands = consent.get(consentKey)
  if (!commands) consent.set(consentKey, commands = { allowed: false })
  const policy: NativePolicy = { cwd, roots, privateDir: options.paths.privateDir, cacheDir: options.paths.cache, attachedPaths: options.attachedPaths ?? [], commands, sandboxed: options.sandboxed, ...(options.mode ? { mode: options.mode } : {}), ...(options.ask ? { ask: options.ask } : {}) }
  return {
    cwd,
    readRoots: roots,
    ...(options.sandboxed ? { sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [options.paths.privateDir], denyWrite: roots.filter(root => root !== cwd && !within(root, cwd)) },
    } } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ready: () => (policy.mode === 'auto' && policy.sandboxed === true) || ((policy.mode ?? 'once') === 'once' && policy.commands.allowed),
    decide: (name, input, signal) => nativeDecision(policy, name, input, signal),
    onCall(name, input) {
      const line = nativeSummary(name, input)
      if (!FREE.has(name)) options.onStep(`${name}: ${line}`)
      options.audit(name, line)
      noteScript(options.channel, name, input)
    },
  }
}
