import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { renameWithRetry } from './rename-with-retry.js'
import { localAliasesPath } from './aliases.js'
import { localOnlyList } from './git.js'
import { vaultPaths, type VaultPaths } from './vault.js'

// There is one workspace now. Everything a person kept in their other workspaces is copied into the one
// that is open: bots and their conversations, sidebar folders, memory, notes and files.
// Copy only: the source folder is never written, and nothing already in the target is replaced.
// Where two things hold the same place, the incoming one takes a name that carries its origin:
//   a bot id      <id>-<tag>             (tag = first 6 hex of sha1 of the source folder path)
//   a bot name    "<name> (<workspace>)" then "<name> (<workspace> 2)", ...
//   a folder name the same way
//   a file        <name>-<tag><.ext>     (a note's `id:` line follows its file name)
// A ledger in the target records each source once it is done, with the ids it chose before anything was
// written, so a run cut short picks up where it stopped and a finished one is never repeated.

export interface MergeSource { root: string; name: string }
interface MergeOptions {
  // false: the target is shared with other people through git. Notes, inbox and sources still arrive, but each
  // file is first named in the repository's own .git/info/exclude (never committed, never pushed), and alias
  // lines go to a file git ignores. A person's other workspaces must not reach a team's repository unasked.
  tracked?: boolean
}
export interface MergeReport {
  root: string
  name: string
  bots: number
  files: number
  // What took another name: "old → new".
  renamed: string[]
  // What was left where it is, and why.
  skipped: string[]
}

type Json = Record<string, unknown>
interface LedgerEntry { name: string; at: string; ids: Record<string, string>; done: boolean; report?: MergeReport }

const LEDGER = 'merged-workspaces.json'
const NAME_MAX = 60
const FOLDER_NAME_MAX = 80
const FOLDERS_MAX = 100

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

async function readJson(path: string): Promise<unknown> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const scratch = `${path}.${process.pid}.merge.tmp`
  await writeFile(scratch, JSON.stringify(value, null, 2))
  await renameWithRetry(scratch, path)
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort()
}

const tagged = (name: string, tag: string): string => { const ext = extname(name); return `${basename(name, ext)}-${tag}${ext}` }

// With a number when the plain one is held: "김대리 (회사)", "김대리 (회사 2)".
function freeName(name: string, origin: string, taken: Set<string>, max: number): string {
  const base = name.trim()
  if (!taken.has(base)) return base
  for (let n = 1; ; n++) {
    const suffix = ` (${origin.trim().slice(0, 20)}${n > 1 ? ` ${n}` : ''})`
    const next = `${base.slice(0, max - suffix.length)}${suffix}`
    if (!taken.has(next)) return next
  }
}

export async function mergeWorkspace(target: VaultPaths, source: MergeSource, options: MergeOptions = {}): Promise<MergeReport | null> {
  const key = resolve(source.root)
  if (key === resolve(target.root)) return null
  const from = vaultPaths(key)
  // A folder that is not there now (an unplugged drive) is tried again another day.
  if (!(await lstat(from.workspace).catch(() => null))?.isDirectory()) return null
  const ledgerPath = join(target.cache, LEDGER)
  const ledger = (await readJson(ledgerPath) ?? {}) as Record<string, LedgerEntry>
  if (ledger[key]?.done) return null

  const tag = createHash('sha1').update(key).digest('hex').slice(0, 6)
  const report: MergeReport = { root: key, name: source.name, bots: 0, files: 0, renamed: [], skipped: [] }

  // Throws on a list that cannot be read: nothing is written over a file this code does not understand.
  const listPath = join(target.cache, 'bots.json')
  const held = await readJson(listPath) ?? { version: 2, bots: [], dismissed: [] }
  if (!isObject(held) || held['version'] !== 2 || !Array.isArray(held['bots'])) throw new Error('The bot list is not ready for a merge.')
  const heldBots = (held['bots'] as unknown[]).filter(isObject), heldGone = (Array.isArray(held['archived']) ? held['archived'] as unknown[] : []).filter(isObject)

  const theirs = await readJson(join(from.cache, 'bots.json')).catch(() => undefined)
  // An older list was never carried into the current format by its own workspace either.
  const current = isObject(theirs) && theirs['version'] === 2 && Array.isArray(theirs['bots'])
  if (!current && theirs !== undefined) report.skipped.push('bots.json: an older format, left in its folder')
  const withId = (list: unknown): Json[] => (Array.isArray(list) ? list : []).filter((one): one is Json => isObject(one) && typeof one['id'] === 'string' && typeof one['name'] === 'string')
  const incoming = current ? withId((theirs as Json)['bots']) : [], incomingGone = current ? withId((theirs as Json)['archived']) : []

  const resumed = ledger[key]
  const ids: Record<string, string> = resumed?.ids ?? {}
  if (!resumed) {
    const takenIds = new Set([...heldBots, ...heldGone].map(bot => String(bot['id'])))
    for (const bot of [...incoming, ...incomingGone]) {
      const id = String(bot['id'])
      let next = id
      for (let n = 1; takenIds.has(next); n++) next = `${id}-${tag}${n > 1 ? `-${n}` : ''}`
      takenIds.add(next)
      ids[id] = next
    }
    // Sidebar folders (teams) too: a copied workspace has the same folder ids, and both folders are kept.
    const foldersOf = (layout: unknown): string[] => isObject(layout) ? ['chat', 'routine'].flatMap(kind => { const group = layout[kind]; return isObject(group) && Array.isArray(group['folders']) ? (group['folders'] as unknown[]).filter(isObject).map(folder => folder['id']).filter((id): id is string => typeof id === 'string') : [] }) : []
    const takenFolders = new Set(foldersOf(await readJson(join(target.cache, 'sidebar-layout.json')).catch(() => undefined)))
    if (current) for (const id of new Set(foldersOf(await readJson(join(from.cache, 'sidebar-layout.json')).catch(() => undefined)))) {
      let next = id
      for (let n = 1; takenFolders.has(next) || Object.hasOwn(ids, next); n++) next = `${id}-${tag}${n > 1 ? `-${n}` : ''}`
      takenFolders.add(next)
      if (!Object.hasOwn(ids, id)) ids[id] = next
    }
    ledger[key] = { name: source.name, at: new Date().toISOString(), ids, done: false }
    await writeJson(ledgerPath, ledger)
  }
  const changed = Object.entries(ids).filter(([old, next]) => old !== next)
  for (const [old, next] of changed) report.renamed.push(`${old} → ${next}`)
  // An id is replaced only where it ends: bot-1a-2 is not the head of bot-1a-2f.
  const mapped = (name: string): string => changed.reduce((value, [old, next]) => value.includes(next) ? value : value.replace(new RegExp(`${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`, 'g'), next), name)

  // Set while copying into what a team's repository tracks: names a path as this computer's own before it is written.
  let keepLocal: ((path: string) => Promise<void>) | null = null
  const copyNew = async (file: string, to: string): Promise<void> => {
    await mkdir(join(to, '..'), { recursive: true })
    // A name already held is not ours to hide; the incoming file could then only land beside it.
    if (keepLocal) await keepLocal(await lstat(to).catch(() => null) ? join(to, '..', tagged(basename(to), tag)) : to)
    try {
      await copyFile(file, to, constants.COPYFILE_EXCL)
      report.files++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const [mine, other] = await Promise.all([readFile(to), readFile(file)])
      if (mine.equals(other)) return
      // Held by something else: the incoming file keeps its own content under a name that says where it came from.
      const aside = join(to, '..', tagged(basename(to), tag))
      const base = basename(to, extname(to))
      const asideText = (text: string) => extname(to) === '.md' ? text.replace(new RegExp(`^id: ["']?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[ \\t]*$`, 'm'), `id: ${base}-${tag}`) : text
      try {
        if (extname(to) === '.md') await writeFile(aside, asideText(other.toString('utf8')), { flag: 'wx' })
        else await copyFile(file, aside, constants.COPYFILE_EXCL)
        report.files++
        report.renamed.push(`${basename(to)} → ${basename(aside)}`)
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code !== 'EEXIST') throw again
      }
    }
  }
  const copyTree = async (dir: string, to: string, rename: (name: string) => string = name => name): Promise<void> => {
    for (const name of await names(dir)) {
      const file = join(dir, name), info = await lstat(file).catch(() => null)
      // A link could lead anywhere on the disk; only what is really in the folder is taken.
      if (!info || info.isSymbolicLink()) continue
      if (info.isDirectory()) { if (name !== '.git') await copyTree(file, join(to, rename(name)), rename); continue }
      if (info.isFile()) await copyNew(file, join(to, rename(name)))
    }
  }

  // Files first. Each lands only where nothing is, so a second pass over them changes nothing.
  if (current) {
    await copyTree(join(from.cache, 'bot-chats'), join(target.cache, 'bot-chats'), mapped)
    await copyTree(join(from.cache, 'bot-avatars'), join(target.cache, 'bot-avatars'), mapped)
    for (const name of await names(join(from.cache, 'bot-memory'))) {
      if (name !== '_person.json') await copyNew(join(from.cache, 'bot-memory', name), join(target.cache, 'bot-memory', mapped(name)))
    }
    for (const name of await names(join(from.workspace, 'tasks'))) {
      if (name.startsWith('bot-')) await copyTree(join(from.workspace, 'tasks', name), join(target.workspace, 'tasks', mapped(name)))
    }
    for (const name of await names(join(from.cache, 'work'))) {
      if (name.startsWith('bot-')) await copyTree(join(from.cache, 'work', name), join(target.cache, 'work', mapped(name)))
    }
  }
  for (const dir of ['artifacts', 'chat-attachments', 'skills']) await copyTree(join(from.cache, dir), join(target.cache, dir))
  await copyTree(join(from.views, 'cards'), join(target.views, 'cards'))
  await copyTree(from.privateDir, target.privateDir)
  // In a team's workspace they arrive as this computer's own: named in the local-only list (and the repository's exclusion file) before they are written.
  keepLocal = options.tracked === false ? await localOnly(target.workspace) : null
  await copyTree(from.notes, target.notes)
  await copyTree(from.inbox, target.inbox)
  await copyTree(from.sources, target.sources)
  await mergeAliases(join(from.workspace, 'aliases.md'), keepLocal ? localAliasesPath(target) : join(target.workspace, 'aliases.md'))
  keepLocal = null

  // What the person told every bot: their lines join the ones already kept.
  const person = await readJson(join(from.cache, 'bot-memory', '_person.json')).catch(() => undefined)
  if (current && isObject(person) && Array.isArray(person['facts'])) {
    const path = join(target.cache, 'bot-memory', '_person.json')
    const mine = await readJson(path).catch(() => undefined)
    const kept: Json = isObject(mine) ? mine : { facts: [], turns: 0 }
    const facts = (Array.isArray(kept['facts']) ? kept['facts'] as unknown[] : []).filter(isObject)
    const said = new Set(facts.map(fact => fact['text'])), factIds = new Set(facts.map(fact => fact['id']))
    const added = (person['facts'] as unknown[]).filter(isObject).filter(fact => typeof fact['text'] === 'string' && !said.has(fact['text']))
      .map(fact => factIds.has(fact['id']) ? { ...fact, id: `${String(fact['id'])}-${tag}` } : fact)
    if (added.length && (isObject(mine) || mine === undefined)) await writeJson(path, { ...kept, facts: [...facts, ...added] })
  }
  // Keyed ledgers: an entry already there stays as it is.
  await addKeys(join(from.cache, 'habits.json'), join(target.cache, 'habits.json'), entry => typeof entry['botId'] === 'string' ? { ...entry, botId: ids[entry['botId']] ?? entry['botId'] } : entry)
  await addKeys(join(from.cache, 'skills-ledger.json'), join(target.cache, 'skills-ledger.json'))
  await addRows(join(from.cache, 'studies.json'), join(target.cache, 'studies.json'), row => String(row['id']), row => typeof row['botId'] === 'string' ? { ...row, botId: ids[row['botId']] ?? row['botId'] } : row)
  await addRows(join(from.cache, 'task-playbooks.json'), join(target.cache, 'task-playbooks.json'), row => String(row['goal']))

  if (current) {
    const here = new Set([...heldBots, ...heldGone].map(bot => String(bot['id'])))
    const takenNames = new Set([...heldBots, ...heldGone].map(bot => String(bot['name']).trim()))
    const arrive = (bot: Json): Json => {
      const id = String(bot['id']), next = ids[id] ?? id
      const name = freeName(String(bot['name']).slice(0, NAME_MAX), source.name, takenNames, NAME_MAX)
      takenNames.add(name)
      if (name !== String(bot['name']).trim()) report.renamed.push(`${String(bot['name']).trim()} → ${name}`)
      // One chief of staff: the one already here. A schedule that was not running in its own workspace does not start by itself.
      const rest = Object.fromEntries(Object.entries(bot).filter(([field]) => field !== 'primary'))
      const avatar = isObject(bot['avatar']) && typeof bot['avatar']['image'] === 'string' ? { avatar: { ...bot['avatar'], image: mapped(bot['avatar']['image']) } } : {}
      const tasks = Array.isArray(bot['tasks']) ? { tasks: (bot['tasks'] as unknown[]).map(task => isObject(task) && task['schedule'] ? { ...task, paused: true } : task) } : {}
      return { ...rest, ...avatar, ...tasks, id: next, name }
    }
    // A mapped id already in the list is this same bot from the run that was cut short.
    const fresh = (list: Json[]) => list.filter(bot => !here.has(ids[String(bot['id'])] ?? String(bot['id']))).map(arrive)
    const active = fresh(incoming), gone = fresh(incomingGone)
    const dismissed = [...new Set([...(Array.isArray(held['dismissed']) ? held['dismissed'] as unknown[] : []), ...(Array.isArray((theirs as Json)['dismissed']) ? (theirs as Json)['dismissed'] as unknown[] : [])])]
    if (active.length || gone.length || dismissed.length !== (Array.isArray(held['dismissed']) ? held['dismissed'].length : 0)) {
      await writeJson(listPath, { ...held, bots: [...held['bots'] as unknown[], ...active], ...(gone.length || held['archived'] ? { archived: [...(Array.isArray(held['archived']) ? held['archived'] as unknown[] : []), ...gone] } : {}), dismissed })
    }
    report.bots = active.length + gone.length
    await mergeSidebar(join(from.cache, 'sidebar-layout.json'), join(target.cache, 'sidebar-layout.json'), source.name, ids, mapped, report)
  }

  ledger[key] = { name: source.name, at: new Date().toISOString(), ids, done: true, report }
  await writeJson(ledgerPath, ledger)
  return report
}

// The person's own files in a team's workspace. Each name goes to the local-only list, which outlives the repository folder and is
// applied again before anything is staged (git.ts keepLocalOnly), and to the repository's exclusion file when there is one now:
// read by git on this computer only, so a path named in it is never staged by `git add -A`.
async function localOnly(workspace: string): Promise<(path: string) => Promise<void>> {
  const list = localOnlyList(workspace)
  await mkdir(join(list, '..'), { recursive: true })
  const listed = new Set((await readFile(list, 'utf8').catch(() => '')).split('\n'))
  const repository = (await lstat(join(workspace, '.git')).catch(() => null))?.isDirectory() === true
  const file = join(workspace, '.git', 'info', 'exclude')
  if (repository) await mkdir(join(file, '..'), { recursive: true })
  const held = repository ? await readFile(file, 'utf8').catch(() => '') : ''
  const lines = new Set(held.split('\n'))
  let open = held !== '' && !held.endsWith('\n')
  const add = async (line: string): Promise<void> => {
    if (!listed.has(line)) { await appendFile(list, `${line}\n`); listed.add(line) }
    if (!repository || lines.has(line)) return
    await appendFile(file, `${open ? '\n' : ''}${line}\n`)
    open = false
    lines.add(line)
  }
  // Bot work folders ignore themselves only once the app has used them here; the list and the private alias lines are this computer's too.
  for (const line of ['/tasks/', '/.engram/local-only', '/.engram/aliases.local.md']) await add(line)
  return async (path) => {
    const rel = relative(workspace, path).split(sep).join('/')
    // Anchored and literal; both spellings of a Korean name, since git may read the folder in either.
    for (const name of new Set([rel, rel.normalize('NFC')])) await add(`/${name.replace(/[\\*?[]/g, '\\$&').replace(/ +$/, spaces => '\\ '.repeat(spaces.length))}`)
  }
}

// Folders are teams, so two may not share a name; an item keeps its folder and its pin.
async function mergeSidebar(fromPath: string, toPath: string, origin: string, ids: Record<string, string>, mapped: (id: string) => string, report: MergeReport): Promise<void> {
  const theirs = await readJson(fromPath).catch(() => undefined)
  if (!isObject(theirs)) return
  const mine = await readJson(toPath).catch(() => null)
  // A layout that cannot be read is the person's own; it is left as it is.
  if (mine === null || (mine !== undefined && !isObject(mine))) { report.skipped.push('sidebar folders: the saved layout here could not be read'); return }
  const layout: Json = mine ?? {}
  let touched = false
  for (const kind of ['chat', 'routine']) {
    const group = isObject(theirs[kind]) ? theirs[kind] : undefined
    if (!group) continue
    const held = isObject(layout[kind]) ? layout[kind] : {}
    const folders = (Array.isArray(held['folders']) ? held['folders'] as unknown[] : []).filter(isObject)
    const items = (Array.isArray(held['items']) ? held['items'] as unknown[] : []).filter(isObject)
    const folderIds = new Set(folders.map(folder => folder['id'])), folderNames = new Set(folders.map(folder => String(folder['name']).trim()))
    const itemIds = new Set(items.map(item => item['id']))
    const arrived = new Map<unknown, string>()
    for (const folder of (Array.isArray(group['folders']) ? group['folders'] as unknown[] : []).filter(isObject)) {
      if (typeof folder['id'] !== 'string' || typeof folder['name'] !== 'string') continue
      // A copied workspace carries the same folder ids: the arriving folder comes under the id chosen for it before anything was written.
      const id = ids[folder['id']] ?? folder['id']
      // That id already here is this same folder from a run that was cut short.
      if (!folderIds.has(id)) {
        if (folders.length >= FOLDERS_MAX) continue
        const name = freeName(folder['name'].slice(0, FOLDER_NAME_MAX), origin, folderNames, FOLDER_NAME_MAX)
        if (name !== folder['name'].trim()) report.renamed.push(`${folder['name'].trim()} → ${name}`)
        folders.push({ ...folder, id, name }); folderIds.add(id); folderNames.add(name); touched = true
      }
      arrived.set(folder['id'], id)
    }
    for (const item of (Array.isArray(group['items']) ? group['items'] as unknown[] : []).filter(isObject)) {
      if (typeof item['id'] !== 'string') continue
      const id = kind === 'chat' ? mapped(item['id']) : item['id']
      if (itemIds.has(id)) continue
      items.push({ ...item, id, folder: arrived.get(item['folder']) ?? null }); itemIds.add(id); touched = true
    }
    layout[kind] = { ...held, folders, items }
  }
  for (const kind of ['chat', 'routine']) if (!isObject(layout[kind])) layout[kind] = { folders: [], items: [] }
  if (touched) await writeJson(toPath, layout)
}

// Only the list lines carry meaning (aliases.ts); a line this file does not have yet is added under its own heading.
async function mergeAliases(fromPath: string, toPath: string): Promise<void> {
  const theirs = await readFile(fromPath, 'utf8').catch(() => '')
  if (!theirs.trim()) return
  const mine = await readFile(toPath, 'utf8').catch(() => null)
  if (mine === null) { await writeFile(toPath, theirs, { flag: 'wx' }).catch(() => undefined); return }
  const UMBRELLA = '## Umbrella terms'
  const split = (text: string) => { const at = text.split('\n').findIndex(line => line.trim() === UMBRELLA), lines = text.split('\n'); return at < 0 ? [lines, []] as const : [lines.slice(0, at), lines.slice(at + 1)] as const }
  const [mineGroups, mineUmbrella] = split(mine), [theirGroups, theirUmbrella] = split(theirs)
  const lacking = (have: readonly string[], more: readonly string[]) => { const seen = new Set(have.map(line => line.trim())); return more.filter(line => line.startsWith('- ') && !seen.has(line.trim()) && seen.add(line.trim())) }
  const groups = lacking(mineGroups, theirGroups), umbrella = lacking(mineUmbrella, theirUmbrella)
  if (!groups.length && !umbrella.length) return
  const head = [...mineGroups.join('\n').trimEnd().split('\n'), ...groups]
  const tail = mineUmbrella.length || umbrella.length ? ['', UMBRELLA, ...mineUmbrella.join('\n').trim().split('\n').filter(Boolean), ...umbrella] : []
  const scratch = `${toPath}.${process.pid}.merge.tmp`
  await writeFile(scratch, [...head, ...tail, ''].join('\n'))
  await renameWithRetry(scratch, toPath)
}

async function addKeys(fromPath: string, toPath: string, carry: (entry: Json) => Json = entry => entry): Promise<void> {
  const theirs = await readJson(fromPath).catch(() => undefined)
  if (!isObject(theirs)) return
  const mine = await readJson(toPath).catch(() => null)
  if (mine === null || (mine !== undefined && !isObject(mine))) return
  const more = Object.entries(theirs).filter(([key]) => !Object.hasOwn(mine ?? {}, key))
  if (more.length) await writeJson(toPath, { ...mine, ...Object.fromEntries(more.map(([key, entry]) => [key, isObject(entry) ? carry(entry) : entry])) })
}

async function addRows(fromPath: string, toPath: string, keyOf: (row: Json) => string, carry: (row: Json) => Json = row => row): Promise<void> {
  const theirs = await readJson(fromPath).catch(() => undefined)
  if (!Array.isArray(theirs)) return
  const mine = await readJson(toPath).catch(() => null)
  if (mine === null || (mine !== undefined && !Array.isArray(mine))) return
  const rows = (mine ?? []) as unknown[], seen = new Set(rows.filter(isObject).map(keyOf))
  const more = theirs.filter(isObject).filter(row => !seen.has(keyOf(row)) && seen.add(keyOf(row))).map(carry)
  if (more.length) await writeJson(toPath, [...rows, ...more])
}
