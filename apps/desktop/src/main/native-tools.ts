import { app } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, fileWorkTools, renameWithRetry, type FileCard, type NativeDecision, type NativeTools, type PermissionMode, type TurnStep, type VaultPaths } from 'core'
import type { Ask } from './page-actions.js'
import { replacedLinks, withCards } from '../shared/file-cards.js'
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
const fold = (text: string): string => text.normalize('NFC').toLowerCase().replaceAll('\\', '/')
export function namedBy(said: string | undefined, path: string): boolean {
  if (!said) return false
  const words = fold(said), file = fold(path), name = file.slice(file.lastIndexOf('/') + 1)
  for (let at = words.indexOf(name); at >= 0; at = words.indexOf(name, at + 1)) {
    if (/^([\w/-]|\.\w)/.test(words.slice(at + name.length))) continue
    const written = /[^\s"'`“”‘’()[\]<>,:]*$/.exec(words.slice(0, at))![0].replace(/^[.~]*\/+/, '') + name
    const upTo = words.slice(0, at + name.length)
    for (let cut = file.lastIndexOf('/'); cut >= 0; cut = cut > 0 ? file.lastIndexOf('/', cut - 1) : -1) {
      const tail = file.slice(cut + 1)
      if (!upTo.endsWith(tail)) break
      if (tail.length >= written.length) return true
    }
  }
  return false
}
const deny = (message: string): NativeDecision => ({ behavior: 'deny', message })
const PLAN_ONLY = 'Plan mode: commands and file changes are off. Read what you need, then reply with the plan.'
const allow: NativeDecision = { behavior: 'allow' }
const DECLINED = 'The person declined a command in this turn, so no command runs until they write again. Do not try another command. Finish with what you have, or ask the person one short plain-language question with ask_person.'

export const commandSandbox = (engineId: string): boolean =>
  engineId === 'codex' || (engineId === 'claude' && process.platform === 'darwin' && process.env['ENGRAM_CLAUDE_SANDBOX'] !== '0')

export interface NativePolicy {
  cwd: string
  roots: string[]
  privateDir: string
  workspace?: string
  named?: string
  cacheDir?: string
  attachedPaths?: string[]
  commands: { allowed: boolean }
  sandboxed?: boolean
  mode?: PermissionMode
  ask?: Ask
  declined?: boolean
  asking?: Promise<unknown>
  member?: boolean
}
const WAITS = /(^|[;&|(]\s*)sleep\s+\d|\bvm_stat\b|\bmemory_pressure\b/
const NO_WAITING = 'Do not wait in a shell: no sleep, no memory polling. Tools take their own turn in line. Call the tool again now, use another source, or report what you have.'

export function nativeSummary(name: string, input: Record<string, unknown>): string {
  const value = SHELLS.has(name) ? input['command'] : name === 'Grep' || name === 'Glob' ? input['pattern'] : name === 'WebFetch' || name === 'WebSearch' ? input['url'] ?? input['query'] : input['file_path'] ?? input['path'] ?? input['notebook_path'] ?? input['description']
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
}

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
      const privateDir = await actualPath(policy.privateDir)
      if (WRITES.has(name)) {
        const box = policy.workspace ? await actualPath(policy.workspace) : undefined, store = policy.cacheDir ? await actualPath(policy.cacheDir) : undefined
        const theirs = !!box && within(box, path) && !(store && within(store, path)) && !within(join(box, 'tasks'), path) && !within(privateDir, path) && namedBy(policy.named, path) && await lstat(path).then(info => info.isFile(), () => false)
        return within(cwd, path) || theirs
          ? { behavior: 'allow', updatedInput: { ...input, [key]: path } }
          : deny(`Write and Edit make new files only inside the task folder ${policy.cwd}; a file the person named that they already keep in their workspace can be changed where it is. Save deliverables with file_create_copy, file_create_workbook or render_file so they are linked and checked.`)
      }
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
    const escaping = input['dangerouslyDisableSandbox'] === true
    const sandboxed = policy.sandboxed === true && !escaping
    const unbounded = (policy.mode === 'auto' && !sandboxed) || escaping
    const each = policy.mode === 'each' || unbounded
    if ((policy.mode === 'auto' && sandboxed) || (!each && policy.commands.allowed)) return allow
    const ask = policy.ask
    if (!ask) return deny('Commands are not available in this chat.')
    if (unbounded && command.length > 16_000) return deny('This command is too long to review. Use a smaller command.')
    const words = each ? `Run this command? ${command.replace(/\s+/g, ' ')}` : policy.sandboxed ? 'Allow commands for this comet? They can read files; writes stay in the task folder and network access is blocked.' : 'Allow commands for this comet? They can read or change any accessible file and use the network; not sandboxed.'
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
async function handedIn(artifacts: string | undefined, answer: string, name: string, path: string): Promise<boolean> {
  if (!artifacts) return true
  const data = await readFile(path).catch(() => null)
  for (const id of linkedIds(answer, name)) if (data && (await readFile(join(artifacts, decodeURIComponent(id))).catch(() => null))?.equals(data)) return true
  return false
}

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

export async function mentionedOutputs(cwd: string, answer: string, since: number, oversized: string[] = [], artifacts?: string, names: HandInNames = {}, made = new Set<string>()): Promise<string[]> {
  const entries = await readdir(cwd, { recursive: true }).catch(() => [] as string[])
  const found: string[] = []
  const depth = (path: string) => path.split(/[\\/]/).length
  const taken = new Set(Object.values(names).map(name => name.toLowerCase())), linked = new Set(linkNames(answer))
  for (const entry of entries.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))) {
    const path = join(cwd, entry), base = basename(entry), key = sourceKey(cwd, path)
    if (base.startsWith('.') || !OUTPUT_EXTENSIONS.has(extname(base).toLowerCase()) || !answer.includes(base)) continue
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile() || !within(await realpath(cwd), await realpath(path)) || info.mtimeMs < since) continue
    let name = names[key]
    if (!name && made.size && linked.has(base.toLowerCase()) && info.size <= OUTPUT_BYTES && made.has(`${createHash('sha256').update(await readFile(path)).digest('hex')}\0${await realpath(path)}`)) continue
    name ??= freeName(base, free => taken.has(free) || linked.has(free))
    taken.add((names[key] = name).toLowerCase())
    if (linkedIds(answer, name).length && info.size <= OUTPUT_BYTES && await handedIn(artifacts, answer, name, path)) continue
    ;(info.size > OUTPUT_BYTES ? oversized : found).push(info.size > OUTPUT_BYTES ? base : path)
  }
  return found
}

export const withFiles = (text: string, files: readonly FileCard[] = []): string => withCards(files.reduce((now, file) => replacedLinks([file]).reduce((kept, old) => kept.replaceAll(`](engram-artifact:${old})`, `](engram-artifact:${file.href})`), now), text), files)
const CORE_HAND_IN = /\.(xlsx|docx|pptx|csv|tsv|md|txt|json)$/i
export async function deliverOutputs(paths: VaultPaths, cwd: string, result: { answer: string; steps: TurnStep[]; files?: FileCard[]; asked?: unknown; stopped?: unknown }, since: number, task: string): Promise<void> {
  if (result.asked) return
  const cards = result.files ??= []
  const card = (link: string, stale: readonly string[] = []): void => {
    const [, name, href] = /^\[(.*)\]\(engram-artifact:([^)\s]+)\)$/.exec(link) ?? []
    if (!name || !href) return
    const at = cards.findIndex(one => stale.includes(one.href))
    const replaces = cards.flatMap(one => stale.includes(one.href) ? one.replaces ?? [] : [])
    for (let i = cards.length - 1; i >= 0; i--) if (stale.includes(cards[i]!.href)) cards.splice(i, 1)
    if (!cards.some(one => one.href === href)) cards.splice(at < 0 ? cards.length : at, 0, { name, href, ...(replaces.length ? { replaces } : {}) })
  }
  const shown = (): string => withFiles(result.answer, cards)
  const file = namesFile(paths, cwd), names = await readNames(file), before = JSON.stringify(names)
  const twins = new Set(result.steps.flatMap(step => { try { const path = step.tool === 'file_create_copy' && typeof step.args['content'] === 'string' ? (JSON.parse(step.observation) as { taskPath?: unknown }).taskPath : undefined; return typeof path === 'string' ? [resolve(cwd, path)] : [] } catch { return [] } }))
  const CONTENT = '\0content'
  const ownArtifact = (step: TurnStep) => latestResultOutputs([step], [])[0]?.path ?? ''
  const madeFrom = (step: TurnStep) => { const input = [step.args['source'], step.args['sourcePath'], step.args['path']].find(value => typeof value === 'string') as string | undefined; return ownArtifact(step) ? `\0${step.tool}\0${input ? resolve(cwd, input) : step.tool === 'file_create_workbook' && typeof step.args['name'] === 'string' ? `name\0${step.args['name'].toLowerCase()}` : createHash('sha256').update(JSON.stringify(step.args)).digest('hex')}` : '' }
  const sourceOf = (step: TurnStep) => { const copy = step.tool === 'file_create_copy', from = copy && typeof step.args['fromPath'] === 'string' ? resolve(cwd, step.args['fromPath']) : copy && typeof step.args['content'] === 'string' ? CONTENT : madeFrom(step); return twins.has(from) ? CONTENT : from }
  const receipts = new Map([...new Set(result.steps.map(sourceOf))].flatMap(source => latestResultOutputs(result.steps.map(step => sourceOf(step) === source ? step : { ...step, seeded: true }), [])).map(output => [output.path, output]))
  const quoted = new Set(result.steps.flatMap(step => { const id = basename(ownArtifact(step)), name = id.replace(SAVED_ID, ''); return id && linkedIds(shown(), name).some(href => href === artifactHref(id) || href === encodeURIComponent(id)) ? [`${name}\0${sourceOf(step)}`] : [] }))
  for (const output of [...receipts.values()].sort((a, b) => a.after! - b.after!)) {
    const id = basename(output.path), others = linkedIds(shown(), output.name), step = result.steps[output.after!]!
    const own = others.find(href => href === artifactHref(id) || href === encodeURIComponent(id))
    const revisions = new Set(result.steps.filter(one => sourceOf(one) === sourceOf(step) && ownArtifact(one)).flatMap(one => [artifactHref(basename(ownArtifact(one))), encodeURIComponent(basename(ownArtifact(one)))]))
    if (own && (!cards.some(one => one.href === own) || !others.slice(0, others.indexOf(own)).some(href => !revisions.has(href)))) continue
    if (!own && quoted.has(`${output.name}\0${sourceOf(step)}`)) continue
    const taskOf = (one: TurnStep) => { try { const path = (JSON.parse(one.observation) as { taskPath?: unknown }).taskPath; return typeof path === 'string' ? resolve(cwd, path) : undefined } catch { return undefined } }
    const twin = taskOf(step)
    const onto = (later: TurnStep) => { const there = taskOf(later); return twin && there ? there === twin : basename(ownArtifact(later)).replace(SAVED_ID, '').toLowerCase() === output.name.toLowerCase() }
    if (!own && result.steps.slice(output.after! + 1).some(later => later.tool === 'file_edit_package' && ownArtifact(later) && typeof later.args['sourcePath'] === 'string' && [output.path, twin].includes(resolve(cwd, later.args['sourcePath'])) && onto(later))) continue
    let link = `[${output.name}](engram-artifact:${artifactHref(id)})`
    if (others.length) {
      try {
        const held = new Set([...Object.values(names).map(name => name.toLowerCase()), ...linkNames(shown())])
        const name = freeName(output.name, free => held.has(free))
        const saved = await saveOutput(artifactDirectory(paths), name, await readFile(output.path))
        for (const earlier of result.steps) if (sourceOf(earlier) === sourceOf(step) && earlier.args['name'] === output.name && earlier.tool === step.tool) earlier.args = { ...earlier.args, name }
        step.observation = JSON.stringify({ ...JSON.parse(step.observation) as object, ...saved })
        link = saved.markdownLink
      } catch (error) { flog('native-tools', `could not rename ${output.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    card(link, own ? [own] : [])
  }
  if (result.stopped) return
  const handIn = fileWorkTools({ directory: artifactDirectory(paths), approveRead: async () => false, handInRoots: [cwd] }).find((tool) => tool.name === 'file_create_copy')!
  const oversized: string[] = []
  await recordOwnCopies(cwd, result.steps, names, shown())
  const hashes = new Set((await readFile(twinsFile(paths, await realpath(cwd).catch(() => cwd)), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\0', 2).join('\0')))
  const named = await mentionedOutputs(cwd, shown(), since, oversized, artifactDirectory(paths), names, hashes)
  if (JSON.stringify(names) !== before) await mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(names))).catch(error => flog('native-tools', `hand-in names not saved: ${error instanceof Error ? error.message : String(error)}`))
  for (const path of named) {
    try {
      const name = names[sourceKey(cwd, path)]!
      const real = await taskFile(paths, cwd, path)
      const raw = async () => JSON.stringify(await saveOutput(artifactDirectory(paths), name, await readFile(real)))
      const observation = CORE_HAND_IN.test(name) ? await handIn.run({ name, fromPath: path }, { task }).catch(raw) : await raw()
      const made = JSON.parse(observation) as { markdownLink: string }
      result.steps.push({ tool: 'file_create_copy', args: { name, fromPath: path }, observation: JSON.stringify({ ...made, handedInFrom: real }) })
      card(made.markdownLink, linkedIds(shown(), name))
    } catch (error) {
      flog('native-tools', `could not hand in ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const name of oversized) flog('native-tools', `${name} is larger than 50 MB, so it stays in the task folder`)
}

const consent = new Map<string, { allowed: boolean }>()

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
async function pruneSpares(paths: VaultPaths): Promise<void> {
  const claimed = new Set(Object.values(await readClaims(paths).catch(() => ({}))).flatMap(value => typeof value === 'string' ? [resolve(value)] : []))
  for (const name of await readdir(taskRoot(paths)).catch(() => [] as string[])) {
    const folder = resolve(taskRoot(paths), name)
    if (name.startsWith('spare-') && !spares.has(folder) && !claimed.has(folder)) await rmdir(folder).catch(() => undefined)
  }
}

export async function cometNativeTools(options: { paths: VaultPaths; channel: string; cwd?: string; member?: string; sandboxed?: boolean; mode?: PermissionMode; attachedPaths?: string[]; named?: string; ask?: Ask; onStep(line: string): void; audit(tool: string, detail: string): void }): Promise<NativeTools & { sandbox?: Record<string, unknown> }> {
  const lead = assignedFolder(options.paths, options.cwd ?? await workFolderFor(options.paths, options.channel))
  if (basename(lead).startsWith('spare-') && !spares.has(lead)) { await pruneSpares(options.paths); spares.add(lead) }
  await ensureTaskFolder(options.paths, lead)
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
  const policy: NativePolicy = { cwd, roots, workspace: options.paths.workspace, privateDir: options.paths.privateDir, cacheDir: options.paths.cache, attachedPaths: options.attachedPaths ?? [], ...(options.named ? { named: options.named } : {}), commands, sandboxed: options.sandboxed, ...(options.mode ? { mode: options.mode } : {}), ...(options.ask ? { ask: options.ask } : {}), ...(options.member ? { member: true } : {}) }
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
