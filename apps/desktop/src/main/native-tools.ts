import { app } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, fileWorkTools, renameWithRetry, type NativeDecision, type NativeTools, type PermissionMode, type TurnStep, type VaultPaths } from 'core'
import type { Ask } from './page-actions.js'
import { artifactDirectory, ensureTaskFolder, freeName, OUTPUT_BYTES, OUTPUT_EXTENSIONS, saveOutput, taskFile, taskRoot, twinsFile } from './file-work.js'
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
  // The person's workspace: read like their Documents (a file they name there needs no card), except Engram's own store and the other
  // chats' task folders. It is no sandbox root: commands write in the task folder alone, and files there are moved with file_move.
  workspace?: string
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
  // A hired team member: it may not sit waiting in a shell.
  member?: boolean
}
// perf146: members answered a busy browser with `sleep 45` and a vm_stat loop, each a full model round the lead waited on.
const WAITS = /(^|[;&|(]\s*)sleep\s+\d|\bvm_stat\b|\bmemory_pressure\b/
const NO_WAITING = 'Do not wait in a shell: no sleep, no memory polling. Tools take their own turn in line. Call the tool again now, use another source, or report what you have.'

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
      const workspace = policy.workspace ? await actualPath(policy.workspace) : undefined
      const inWorkspace = !!workspace && within(workspace, path) && !(cache && within(cache, path)) && !within(join(workspace, 'tasks'), path) && !(search && within(path, join(workspace, 'tasks')))
      if (!within(privateDir, path) && !protectedSearch && (inRoot || inWorkspace || attached.includes(path))) return { behavior: 'allow', updatedInput: { ...input, [key]: path } }
    } catch { return deny('The file location could not be verified.') }
    return deny('Only files in the task folder, the person\'s workspace, this chat\'s attachments, saved outputs, Documents, Desktop and Downloads can be read directly. Search a narrower folder or ask the person to attach anything else.')
  }
  if (SHELLS.has(name)) {
    const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
    if (!command) return deny('Supply a command.')
    if (policy.mode === 'plan') return deny(PLAN_ONLY)
    if (policy.declined) return deny(DECLINED)
    if (policy.member && WAITS.test(command)) return deny(NO_WAITING)
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

// Which hand-in name each task file has, by its path inside the task folder: two/report.md stays report-2.md in every later turn.
// Kept beside the saved outputs, outside the folder the comet writes in.
type HandInNames = Record<string, string>
const namesFile = (paths: VaultPaths, cwd: string) => join(paths.cache, 'hand-ins', `${createHash('sha256').update(cwd).digest('hex').slice(0, 32)}.json`)
async function readNames(file: string): Promise<HandInNames> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  } catch { return {} }
}
const sourceKey = (cwd: string, path: string) => relative(cwd, path).split(/[\\/]/).join('/')
const SAVED_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i
const linkNames = (answer: string) => [...answer.matchAll(/\(engram-artifact:([^)\s]+)\)/g)].flatMap(match => { try { return [decodeURIComponent(match[1]!).replace(SAVED_ID, '').toLowerCase()] } catch { return [] } })
// The comet's own copies go on record under the source their receipt names: fromPath, else the task-folder twin made from content.
// Only that source may later replace the link; a name another source already holds is left alone.
// The copy the answer itself links claims its name first: an earlier copy of another source under that name is a version it replaced.
async function recordOwnCopies(cwd: string, steps: TurnStep[], names: HandInNames, answer = ''): Promise<void> {
  const roots = [cwd, await realpath(cwd).catch(() => cwd)]
  const quoted = (step: TurnStep) => { try { const id = basename((JSON.parse(step.observation) as { path: string }).path); return answer.includes(`(engram-artifact:${artifactHref(id)})`) || answer.includes(`(engram-artifact:${encodeURIComponent(id)})`) } catch { return false } }
  for (const step of [...steps.filter(quoted), ...steps.filter(step => !quoted(step))]) {
    if (step.tool !== 'file_create_copy' || step.seeded) continue
    let made: Record<string, unknown>
    try { made = JSON.parse(step.observation) as Record<string, unknown> } catch { continue }
    if (!made || typeof made !== 'object' || made['error'] || typeof made['path'] !== 'string' || made['handedInFrom']) continue
    const source = typeof step.args['fromPath'] === 'string' ? resolve(cwd, step.args['fromPath']) : typeof made['taskPath'] === 'string' ? resolve(cwd, made['taskPath']) : undefined
    const root = typeof source === 'string' ? roots.find(root => within(root, source)) : undefined
    if (!root) continue
    const key = sourceKey(root, source as string), name = basename(made['path']).replace(SAVED_ID, '')
    if (!names[key] && !Object.values(names).some(taken => taken.toLowerCase() === name.toLowerCase())) names[key] = name
  }
}

// A file the comet built in its task folder this turn and named in its answer,
// but never handed in: the person was told about it, so it becomes an output.
// names (source path in the task folder -> hand-in name) is filled in for every file found or already handed in.
// made: the task files receipts themselves placed, as `hash\0path` (twinsFile). Such a file, still holding the bytes it was placed with
// under a name the answer links, is that receipt's task-folder twin (a render's own copy, current or superseded), not another output.
// Nothing else is a twin: any other path with the same bytes, the top-level file of the linked name included, is another file,
// so two source paths under one name stay two files in either direction (qa143 S19a r11, r12).
export async function mentionedOutputs(cwd: string, answer: string, since: number, oversized: string[] = [], artifacts?: string, names: HandInNames = {}, made = new Set<string>()): Promise<string[]> {
  const entries = await readdir(cwd, { recursive: true }).catch(() => [] as string[])
  const found: string[] = []
  const depth = (path: string) => path.split(/[\\/]/).length
  // A name belongs to one source: the ones on record. A link the answer already carries with no record is never claimed or replaced: a new file gets the next free name.
  const taken = new Set(Object.values(names).map(name => name.toLowerCase())), linked = new Set(linkNames(answer))
  // Shallowest path first, so the top-level file keeps the plain name.
  for (const entry of entries.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))) {
    const path = join(cwd, entry), base = basename(entry), key = sourceKey(cwd, path)
    // No location is excluded: a check's scratch stays out because the answer does not name it, and a file the answer names is handed in wherever it is.
    if (base.startsWith('.') || !OUTPUT_EXTENSIONS.has(extname(base).toLowerCase()) || !answer.includes(base)) continue
    // lstat: a link is never a deliverable.
    const info = await lstat(path).catch(() => null)
    // A file reached through a linked directory is outside the task folder.
    if (!info?.isFile() || !within(await realpath(cwd), await realpath(path)) || info.mtimeMs < since) continue
    let name = names[key]
    if (!name && made.size && linked.has(base.toLowerCase()) && info.size <= OUTPUT_BYTES && made.has(`${createHash('sha256').update(await readFile(path)).digest('hex')}\0${await realpath(path)}`)) continue
    name ??= freeName(base, free => taken.has(free) || linked.has(free))
    taken.add((names[key] = name).toLowerCase())
    // An oversized revision cannot match a saved output, so it still gets its size warning.
    if (linkedIds(answer, name).length && info.size <= OUTPUT_BYTES && await handedIn(artifacts, answer, name, path)) continue
    ;(info.size > OUTPUT_BYTES ? oversized : found).push(info.size > OUTPUT_BYTES ? base : path)
  }
  return found
}

const CORE_HAND_IN = /\.(xlsx|docx|pptx|csv|tsv|md|txt|json)$/i
// Every output of the turn reaches the answer as a file link: the ones a tool
// saved (even when the turn was cut short, since each was read back), and the
// raw files the answer names when the turn finished.
export async function deliverOutputs(paths: VaultPaths, cwd: string, result: { answer: string; steps: TurnStep[]; asked?: unknown; stopped?: unknown }, since: number, task: string): Promise<void> {
  if (result.asked) return
  const file = namesFile(paths, cwd), names = await readNames(file), before = JSON.stringify(names)
  // Every receipt of the turn, not the last one per name: two sources copied under one name are two files. A later copy of the same source
  // (or of content, or of a content copy's task-folder twin) is a revision, and only the last revision counts.
  const twins = new Set(result.steps.flatMap(step => { try { const path = step.tool === 'file_create_copy' && typeof step.args['content'] === 'string' ? (JSON.parse(step.observation) as { taskPath?: unknown }).taskPath : undefined; return typeof path === 'string' ? [resolve(cwd, path)] : [] } catch { return [] } }))
  // A receipt with no fromPath has no source it could be a revision of, whatever tool made it: it is its own source, known by its artifact, so two made under one name are two files.
  // Only content copies (and copies of their task-folder twins) share a source, CONTENT, where the last revision per name counts.
  const CONTENT = '\0content'
  // The artifact a creation receipt made; nothing for any other step (a read's observation names a path too).
  const ownArtifact = (step: TurnStep) => latestResultOutputs([step], [])[0]?.path ?? ''
  // What a receipt with no fromPath was made from: its tool and the file it names (a render's source, an edited package), or, for inline input, the input itself.
  // The same tool on the same input under the same name is one file made again (a report re-rendered after a fix): a revision, where the last one counts.
  // Two different inputs under one name are two files, inline html or markdown included: nothing says one replaces the other, and a file is never dropped on a guess.
  // qa143 S19: three renders of one report were handed over as report, report-2 and report-3.
  const madeFrom = (step: TurnStep) => { const input = [step.args['source'], step.args['sourcePath'], step.args['path']].find(value => typeof value === 'string') as string | undefined; return ownArtifact(step) ? `\0${step.tool}\0${input ? resolve(cwd, input) : createHash('sha256').update(JSON.stringify(step.args)).digest('hex')}` : '' }
  const sourceOf = (step: TurnStep) => { const copy = step.tool === 'file_create_copy', from = copy && typeof step.args['fromPath'] === 'string' ? resolve(cwd, step.args['fromPath']) : copy && typeof step.args['content'] === 'string' ? CONTENT : madeFrom(step); return twins.has(from) ? CONTENT : from }
  const receipts = new Map([...new Set(result.steps.map(sourceOf))].flatMap(source => latestResultOutputs(result.steps.map(step => sourceOf(step) === source ? step : { ...step, seeded: true }), [])).map(output => [output.path, output]))
  // The sources whose artifact the answer itself already links, by name: where the comet quoted one version of a file, that source's other
  // versions under the name are the ones it replaced, and are not handed over beside it. Another source under that name is another file, and is.
  const quoted = new Set(result.steps.flatMap(step => { const id = basename(ownArtifact(step)), name = id.replace(SAVED_ID, ''); return id && linkedIds(result.answer, name).some(href => href === artifactHref(id) || href === encodeURIComponent(id)) ? [`${name}\0${sourceOf(step)}`] : [] }))
  for (const output of [...receipts.values()].sort((a, b) => a.after! - b.after!)) {
    // A receipt is linked when the answer carries its own artifact, not merely a file of its name.
    const id = basename(output.path), others = linkedIds(result.answer, output.name), step = result.steps[output.after!]!
    const own = others.find(href => href === artifactHref(id) || href === encodeURIComponent(id))
    // Its own link is enough only while no other source's file is linked under this name ahead of it. Core attaches every unlinked source under
    // the name it was given, so two inputs arrive here as two links both reading report.md, and a file is known by its name from here on
    // (the readback gate, later turns): the later one is named apart like any second source (qa143 S19a). Its own revisions are not another source.
    const revisions = new Set(result.steps.filter(one => sourceOf(one) === sourceOf(step) && ownArtifact(one)).flatMap(one => [artifactHref(basename(ownArtifact(one))), encodeURIComponent(basename(ownArtifact(one)))]))
    if (own && !others.slice(0, others.indexOf(own)).some(href => !revisions.has(href))) continue
    if (!own && quoted.has(`${output.name}\0${sourceOf(step)}`)) continue
    let link = `[${output.name}](engram-artifact:${artifactHref(id)})`
    if (others.length) {
      // The answer keeps another artifact under this name, and files are known by name: this one is saved under the next free name, so both stay linked and checked.
      try {
        const held = new Set([...Object.values(names).map(name => name.toLowerCase()), ...linkNames(result.answer)])
        const name = freeName(output.name, free => held.has(free))
        const saved = await saveOutput(artifactDirectory(paths), name, await readFile(output.path))
        // Its earlier revisions in this turn move with it, so the old name's latest receipt stays the other source's.
        for (const earlier of result.steps) if (sourceOf(earlier) === sourceOf(step) && earlier.args['name'] === output.name && earlier.tool === step.tool) earlier.args = { ...earlier.args, name }
        step.observation = JSON.stringify({ ...JSON.parse(step.observation) as object, ...saved })
        link = saved.markdownLink
      } catch (error) { flog('native-tools', `could not rename ${output.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    // An own link that could not be renamed stays as it is: the readback gate keeps same-name files apart by path.
    result.answer = own ? result.answer.replace(/\[[^\]\r\n]*\]\(engram-artifact:([^)\s]+)\)/g, (whole, href) => href === own ? link : whole) : `${result.answer}\n\n${link}`
  }
  if (result.stopped) return
  const handIn = fileWorkTools({ directory: artifactDirectory(paths), approveRead: async () => false, handInRoots: [cwd] }).find((tool) => tool.name === 'file_create_copy')!
  const oversized: string[] = []
  // Every new task file the answer names is handed in: nothing is left out by guessing what a file is for.
  // A hand-in is known by its source's path in the task folder, so two files with one name in different folders keep distinct names (report.md, report-2.md) and links, in this turn and later ones.
  await recordOwnCopies(cwd, result.steps, names, result.answer)
  // Read from the placement record, not from the receipts' taskPath: a receipt also names a same-byte file it found already there, and that one is another source.
  const hashes = new Set((await readFile(twinsFile(paths, await realpath(cwd).catch(() => cwd)), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\0', 2).join('\0')))
  const named = await mentionedOutputs(cwd, result.answer, since, oversized, artifactDirectory(paths), names, hashes)
  if (JSON.stringify(names) !== before) await mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(names))).catch(error => flog('native-tools', `hand-in names not saved: ${error instanceof Error ? error.message : String(error)}`))
  for (const path of named) {
    try {
      const name = names[sourceKey(cwd, path)]!
      const real = await taskFile(paths, cwd, path)
      const raw = async () => JSON.stringify(await saveOutput(artifactDirectory(paths), name, await readFile(real)))
      // Core reads text back under its own 8 MB limit; a larger file still goes in as made, up to the 50 MB cap.
      const observation = CORE_HAND_IN.test(name) ? await handIn.run({ name, fromPath: path }, { task }).catch(raw) : await raw()
      const made = JSON.parse(observation) as { markdownLink: string }
      // handedInFrom marks the host's own copy of a task file: the result check takes a full read of those bytes before the report as its readback.
      result.steps.push({ tool: 'file_create_copy', args: { name, fromPath: path }, observation: JSON.stringify({ ...made, handedInFrom: real }) })
      const link = made.markdownLink, stale = linkedIds(result.answer, name)
      // The revised file replaces its own earlier hand-in where the answer quoted it; another source's link, or one with no record, has another name.
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
  const policy: NativePolicy = { cwd, roots, workspace: options.paths.workspace, privateDir: options.paths.privateDir, cacheDir: options.paths.cache, attachedPaths: options.attachedPaths ?? [], commands, sandboxed: options.sandboxed, ...(options.mode ? { mode: options.mode } : {}), ...(options.ask ? { ask: options.ask } : {}), ...(options.member ? { member: true } : {}) }
  return {
    cwd,
    workspace: options.paths.workspace,
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
