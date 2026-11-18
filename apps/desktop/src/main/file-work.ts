import { app, ipcMain, nativeImage, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, link, lstat, mkdir, open, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, fileWorkTools, renameWithRetry, workbookTool, resolveArtifact, findLocalFiles, type VaultPaths, type AgentTool, readArtifact } from 'core'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { fitImage } from './image-fit.js'
import { flog } from './flog.js'
import { renderTool } from './render-file.js'
import type { ArtifactViewDto } from '../shared/types.js'
import type { Ask } from './page-actions.js'
import { READ_CARD } from './read-card.js'
import { fileMoveTool } from './file-move.js'

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}
export const artifactDirectory = (paths: VaultPaths) => join(paths.cache, 'artifacts')

const REVISION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i

export const taskRoot = (paths: VaultPaths) => join(paths.workspace, 'tasks')
export const OUTPUT_BYTES = 50_000_000
export const OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set('.pdf .docx .xlsx .pptx .csv .tsv .md .txt .json .html .png .jpg .jpeg .svg .gif .py .js .ts .sh .ps1 .zip'.split(' '))
const CORE_OUTPUTS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.docx', '.pptx', '.xlsx'])
const TEXT_OUTPUTS = new Set(['.html', '.svg', '.py', '.js', '.ts', '.sh', '.ps1'])
const kindOf = (name: string) => extname(name).toLowerCase()
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'

function outputName(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. ()-]{0,119}$/u.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || !OUTPUT_EXTENSIONS.has(kindOf(value))) throw new Error('Use a plain filename with a supported extension, without directories.')
  return value
}

export async function ensureTaskFolder(paths: VaultPaths, folder: string): Promise<string> {
  await mkdir(taskRoot(paths), { recursive: true })
  const escape = new Error('A comet work folder cannot redirect outside this workspace.')
  if ((await lstat(taskRoot(paths))).isSymbolicLink() || !within(await realpath(paths.workspace), await realpath(taskRoot(paths)))) throw escape
  await writeFile(join(taskRoot(paths), '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => { if (!exists(error)) throw error })
  await mkdir(folder, { recursive: true })
  if ((await lstat(folder)).isSymbolicLink() || !within(await realpath(paths.workspace), await realpath(folder))) throw escape
  return realpath(folder)
}

export async function taskFile(paths: VaultPaths, folder: string, requested: unknown): Promise<string> {
  const outside = new Error('The file must be inside the task folder.')
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw outside
  const path = resolve(folder, requested)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile()) throw outside
  const real = await realpath(path)
  if (!within(await realpath(folder), real) || within(await realpath(paths.privateDir).catch(() => resolve(paths.privateDir)), real)) throw outside
  if (info.size > OUTPUT_BYTES) throw new Error('The file is larger than 50 MB.')
  return real
}

export const twinsFile = (paths: VaultPaths, folder: string) => join(paths.cache, 'hand-ins', `${createHash('sha256').update(folder).digest('hex').slice(0, 32)}.twins`)
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

interface Placement { source: string; turn?: string; artifact?: string; outputs?: string }
const versionsFile = (handIns: string) => join(handIns, 'previous')
const replacedFile = (handIns: string) => join(handIns, 'replaced')
export async function previousVersions(paths: VaultPaths, id: string): Promise<string[]> {
  const rows = (await readFile(versionsFile(join(paths.cache, 'hand-ins')), 'utf8').catch(() => '')).split('\n').map(line => line.split('\0'))
  const chain: string[] = []
  for (let at = id; chain.length < 20;) {
    const before = rows.filter(row => row[0] === at).at(-1)?.[1]
    if (!before || before === id || chain.includes(before)) break
    chain.push(at = before)
  }
  const found = await Promise.all(chain.map(earlier => storedArtifact(artifactDirectory(paths), earlier).then(() => earlier, () => '')))
  return found.filter(Boolean)
}
const madeFrom = (tool: string, args: Record<string, unknown>, cwd: string): string => {
  if (tool === 'file_create_copy' && typeof args.fromPath === 'string') return `path\0${resolve(cwd, args.fromPath)}`
  if (tool === 'file_create_copy' && typeof args.content === 'string') return 'content'
  const input = [args.source, args.sourcePath, args.path].find(value => typeof value === 'string') as string | undefined
  return `${tool}\0${input ? resolve(cwd, input) : tool === 'file_create_workbook' && typeof args.name === 'string' ? `name\0${args.name.toLowerCase()}` : sha(JSON.stringify(args))}`
}

export async function placeInTask(folder: string, name: string, data: Buffer, record?: string, made?: Placement): Promise<string> {
  outputName(name)
  const tmp = join(folder, `.${randomUUID()}.tmp`), dot = name.lastIndexOf('.'), source = JSON.stringify(made?.source ?? null)
  const note = async (path: string) => { if (record) await mkdir(dirname(record), { recursive: true }).then(() => appendFile(record, `${sha(data)}\0${path}\0${made?.turn ?? ''}\0${source}\0${made?.artifact ?? ''}\n`)).catch(error => flog('file-work', `twin not recorded: ${error instanceof Error ? error.message : String(error)}`)) }
  const spot = (count: number) => join(folder, count === 1 ? name : `${name.slice(0, dot)} (${count})${name.slice(dot)}`)
  const rows = record && made ? (await readFile(record, 'utf8').catch(() => '')).split('\n').map(line => line.split('\0')) : []
  const last = (at: string) => rows.filter(line => line[1] === at).at(-1)
  const retire = async (was: string | undefined, whole: boolean) => {
    if (!record || !made?.artifact || !was || was === made.artifact) return
    const others = whole ? await readdir(dirname(record)).then(names => Promise.all(names.filter(file => file.endsWith('.twins') && file !== basename(record)).map(file => readFile(join(dirname(record), file), 'utf8'))), () => null) : null
    if (made.outputs && others && !others.some(rows => rows.includes(`\0${was}\n`))) await resolveOutput(made.outputs, was).then(unlink).then(() => appendFile(replacedFile(dirname(record)), `${was}\0${made.artifact}\n`)).catch(error => flog('file-work', `earlier version not removed: ${error instanceof Error ? error.message : String(error)}`))
    else await appendFile(versionsFile(dirname(record)), `${made.artifact}\0${was}\n`).catch(error => flog('file-work', `version not recorded: ${error instanceof Error ? error.message : String(error)}`))
  }
  const edited = made?.source.startsWith('file_edit_package\0') ? await realpath(made.source.split('\0')[1]!).catch(() => made.source.split('\0')[1]!) : ''
  const target = !edited ? undefined : last(edited) ? edited : rows.filter(row => row[4] === basename(edited)).map(row => row[1]!).filter(path => last(path)?.[4] === basename(edited)).at(-1)
  const plainName = (file: string) => basename(file).replace(/ \(\d+\)(?=\.[^.]+$)/, '').normalize('NFC').toLowerCase()
  await writeFile(tmp, data, { flag: 'wx' })
  try {
    if (target && dirname(target) === folder && plainName(target) === plainName(name)) {
      const held = await readFile(target).catch(() => null), [hash, , , , was] = last(target)!
      if (held?.equals(data)) return target
      if (held && hash === sha(held)) {
        await renameWithRetry(tmp, target)
        await note(target)
        await retire(was, true)
        return target
      }
    }
    for (let count = 1; count < 100; count += 1) {
      const path = spot(count)
      try {
        await link(tmp, path)
        await note(path)
        return path
      } catch (error) {
        if (!exists(error)) throw error
        const info = await lstat(path)
        if (!info.isFile()) continue
        const held = await readFile(path)
        if (held.equals(data)) return path
        if (!record || !made) continue
        const [hash, , turn, from, was] = last(path) ?? []
        if (hash !== sha(held) || !from) continue
        const copies = (value: string) => value.startsWith('"path\\u0000')
        if (from !== source && (edited || !(made.turn && turn && turn !== made.turn && !(copies(from) && copies(source))))) continue
        if (from !== source && Array.from({ length: 99 }, (_, at) => spot(at + 1)).some(other => other !== path && last(other)?.[3] === source)) continue
        await renameWithRetry(tmp, path)
        await note(path)
        await retire(was, !!made.turn && turn === made.turn)
        return path
      }
    }
    throw new Error('Too many files in the task folder share this name.')
  } finally { await unlink(tmp).catch(() => undefined) }
}

const placeTwin = async (paths: VaultPaths, folder: string, name: string, data: Buffer, made: Placement) => { const real = await ensureTaskFolder(paths, folder); return placeInTask(real, name, data, twinsFile(paths, real), { ...made, outputs: artifactDirectory(paths) }) }

export function freeName(base: string, held: (name: string) => boolean): string {
  for (let count = 1; ; count++) {
    const free = count === 1 ? base : `${basename(base, extname(base))}-${count}${extname(base)}`
    if (!held(free.toLowerCase())) return free
  }
}

export async function saveOutput(directory: string, name: string, data: Buffer) {
  outputName(name)
  if (data.length > OUTPUT_BYTES) throw new Error('Generated output exceeds 50 MB.')
  if (kindOf(name) === '.png' && data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('The output is not a PNG image.')
  if (kindOf(name) === '.pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The output is not a PDF document.')
  await mkdir(directory, { recursive: true })
  const root = await realpath(directory)
  const hash = createHash('sha256').update(name).update(data).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}-${name}`
  const path = join(root, id)
  try {
    const handle = await open(path, 'wx')
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  } catch (error) { if (!exists(error)) throw error }
  if (await resolveOutput(root, id) !== path) throw new Error('The output path changed.')
  const actual = await readFile(path)
  if (!actual.equals(data)) throw new Error('Output readback did not match. Do not retry the write; inspect the output first.')
  return { artifact: id, path, link: `engram-artifact:${id}`, markdownLink: `[${name}](engram-artifact:${artifactHref(id)})`, sha256: createHash('sha256').update(actual).digest('hex'), bytes: actual.length, originalUnchanged: true, completeReadback: true }
}

export async function resolveOutput(directory: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !REVISION.test(value)) throw new Error('Invalid artifact.')
  try { outputName(value.slice(37)) } catch { throw new Error('Invalid artifact.') }
  const root = await realpath(directory)
  const path = await realpath(join(root, value)).catch(() => '')
  if (!path || relative(root, path) !== value || !(await stat(path)).isFile()) throw new Error('Artifact is outside this chat.')
  return path
}
const storedArtifact = (directory: string, id: unknown) => resolveOutput(directory, id).catch(() => resolveArtifact(directory, id))
const findArtifact = (directory: string, id: unknown) => storedArtifact(directory, id).catch(async error => {
  const rows = (await readFile(replacedFile(join(dirname(directory), 'hand-ins')), 'utf8').catch(() => '')).split('\n').map(line => line.split('\0'))
  let now = id
  for (let hops = 0; hops < 50; hops += 1) { const next = rows.filter(row => row[0] === now).at(-1)?.[1]; if (!next) break; now = next }
  if (now === id) throw error
  return storedArtifact(directory, now)
})

export async function linkedOutputs(directory: string, history: { role: string; text: string }[] | undefined, every = false): Promise<{ name: string; path: string }[]> {
  const latest = new Map<string, string>()
  for (const turn of history ?? []) {
    if (turn.role !== 'assistant') continue
    for (const match of turn.text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)) {
      let id: string
      try { id = decodeURIComponent(match[1]!) } catch { continue }
      const name = id.replace(REVISION, '')
      latest.delete(every ? id : name)
      latest.set(every ? id : name, id)
    }
  }
  const found: { name: string; path: string }[] = []
  for (const id of [...latest.values()].slice(-40)) {
    try { found.push({ name: id.replace(REVISION, ''), path: await findArtifact(directory, id) }) } catch { }
  }
  return found
}
export async function checkedOutputs(directory: string, answer: string, rechecked?: string, stands = false): Promise<{ name: string; path: string; kept?: true }[]> {
  const own = await linkedOutputs(directory, [{ role: 'assistant', text: answer }], true)
  if (rechecked === undefined) return own
  const linked = await linkedOutputs(directory, [{ role: 'assistant', text: rechecked }], true)
  const twin = (output: { name: string; path: string }) => linked.some(other => other.name === output.name && other.path !== output.path)
  const earlier = linked.filter(output => !own.some(now => stands || twin(output) ? now.path === output.path : now.name === output.name))
  return [...earlier.map(output => stands ? { ...output, kept: true as const } : output), ...own.filter(linked => !stands || !earlier.some(output => output.path === linked.path))]
}

export async function newestRevisions(directory: string, text: string, since: number, outputs: string[]): Promise<string> {
  const files = outputs.map(path => basename(path))
  let out = text
  for (const match of text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)) {
    let id: string
    try { id = decodeURIComponent(match[1]!) } catch { continue }
    const name = id.replace(REVISION, '')
    let best = { id, at: (await stat(join(directory, id)).catch(() => null))?.mtimeMs ?? 0 }
    for (const file of files) {
      if (file === id || file.replace(REVISION, '') !== name || !REVISION.test(file)) continue
      const info = await stat(join(directory, file)).catch(() => null)
      if (info && info.mtimeMs > best.at && info.mtimeMs >= since) best = { id: file, at: info.mtimeMs }
    }
    if (best.id !== id) out = out.split(`engram-artifact:${match[1]})`).join(`engram-artifact:${artifactHref(best.id)})`)
  }
  return out
}

const USER_FOLDERS = ['documents', 'desktop', 'downloads'] as const

export function taskOutputs(paths: VaultPaths, folder?: () => Promise<string | undefined>, made?: Set<string>, turn?: string) {
  return {
    async held(): Promise<Set<string>> { const task = await folder?.(); return new Set(task ? (await readdir(task).catch(() => [] as string[])).map(file => file.normalize('NFC').toLowerCase()) : []) },
    async save(name: string, data: Buffer): Promise<Record<string, unknown>> {
      const receipt = await saveOutput(artifactDirectory(paths), name, data)
      made?.add(receipt.path)
      const task = await folder?.()
      if (!task) return receipt
      try { return { ...receipt, taskPath: await placeTwin(paths, task, name, data, { source: 'composed', turn, artifact: receipt.artifact }) } }
      catch (error) { flog('file-work', `no task copy: ${error instanceof Error ? error.message : String(error)}`); return receipt }
    },
  }
}

interface ReadConsent { ask?: Ask; korean?: () => boolean; made?: ReadonlySet<string>; turn?: string }

export function cometFileTools(paths: VaultPaths, lane: string, attachedPaths: string[] = [], handInRoots: string[] = [], consent: ReadConsent = {}) {
  const approved = new Set(attachedPaths)
  const directory = artifactDirectory(paths), folder = handInRoots[0]
  const active = () => assertDesktopTurnNotStopped(lane)
  const placement = (tool: string, args: Record<string, unknown>): Placement => ({ source: madeFrom(tool, args, folder!), turn: consent.turn })
  const save = async (name: string, data: Buffer, made: Placement) => {
    const receipt = await saveOutput(directory, name, data)
    approved.add(receipt.path)
    return { ...receipt, taskPath: await placeTwin(paths, folder!, name, data, { ...made, artifact: receipt.artifact }) }
  }
  const createWide = async (args: Record<string, unknown>): Promise<string> => {
    const name = outputName(args.name)
    if (args.sourcePath !== undefined || args.expectedSha256 !== undefined) throw new Error('Revisions by source are for text and Office files.')
    if ((typeof args.content === 'string') === (typeof args.fromPath === 'string')) throw new Error('Supply exactly one of content or fromPath.')
    let data: Buffer
    if (typeof args.content === 'string') {
      if (!TEXT_OUTPUTS.has(kindOf(name))) throw new Error('Build this kind of file in the task folder and hand it in with fromPath.')
      data = Buffer.from(args.content, 'utf8')
      if (data.length > 8_000_000 || args.content.includes('\0') || data.toString('utf8') !== args.content) throw new Error('Content must be valid text up to 8 MB.')
    } else {
      const source = await taskFile(paths, await ensureTaskFolder(paths, folder!), args.fromPath)
      if (kindOf(source) !== kindOf(name)) throw new Error('The name must keep the file\'s extension.')
      data = await readFile(source)
    }
    active()
    return JSON.stringify(await save(name, data, placement('file_create_copy', args)))
  }
  const ownRoots = async (): Promise<string[]> => {
    const realTaskRoot = await realpath(taskRoot(paths)).catch(() => '')
    const own = await Promise.all(handInRoots.map(root => ensureTaskFolder(paths, root).then(real => realTaskRoot && within(realTaskRoot, real) ? real : '', () => '')))
    return own.filter(Boolean)
  }
  const assertReadable = async (path: string) => {
    if (within(await realpath(paths.privateDir), path)) throw new Error('Private vault files are not available to the agent.')
  }
  return [...fileWorkTools({
    directory: artifactDirectory(paths),
    handInRoots: ownRoots,
    assertActive: active,
    assertReadable,
    findFiles: (query, signal) => findLocalFiles(USER_FOLDERS.map((dir) => app.getPath(dir)), paths.privateDir, query, signal),
    approveRead: async (path, signal) => {
      signal?.throwIfAborted()
      await assertReadable(path)
      if ((approved.has(path) || consent.made?.has(path)) && await realpath(path) === path) return true
      const real = await realpath(path)
      if ((await ownRoots()).some(root => within(root, real))) return true
      const roots = await Promise.all(USER_FOLDERS.map(name => realpath(app.getPath(name)).catch(() => '')))
      if (roots.some(root => root && within(root, real))) return true
      const [workspace, cache] = await Promise.all([realpath(paths.workspace).catch(() => ''), realpath(paths.cache).catch(() => resolve(paths.cache))])
      if (folder && workspace && within(workspace, real) && !within(cache, real) && !within(join(workspace, 'tasks'), real)) return true
      if (!consent.ask) return false
      const words = consent.korean?.()
        ? `이 파일을 읽어도 될까요? 내용이 연결된 AI에 전달돼요. 원본 파일은 바뀌지 않아요.\n${path}`
        : `Read this file? Its contents go to your connected AI. The original file is not changed.\n${path}`
      const verdict = await consent.ask({ words, url: `${pathToFileURL(real).href}${READ_CARD}` })
      signal?.throwIfAborted()
      assertDesktopTurnNotStopped(lane)
      if (verdict !== 'approve' && verdict !== 'always') return false
      approved.add(path)
      return true
    },
  }), workbookTool(directory, active), ...(folder ? [fileMoveTool(paths, active), renderTool({ folder: () => ensureTaskFolder(paths, folder), source: async (path) => taskFile(paths, await ensureTaskFolder(paths, folder), path), save: (name, data, args) => save(name, data, placement('render_file', args)), assertActive: active })] : [])].map((tool): AgentTool => ({ ...tool, ...(tool.name === 'file_create_copy' && folder ? { description: `${tool.description} With content or fromPath it also saves HTML, SVG and scripts (py, js, ts, sh, ps1); with fromPath also PDF, PNG, JPG, GIF and ZIP built in the task folder, up to 50 MB.` } : {}), ...(tool.runRich ? { runRich: async (args, context) => {
    assertDesktopTurnNotStopped(lane)
    const outcome = await tool.runRich!(args, context)
    return outcome.image ? { ...outcome, image: fitImage(outcome.image) } : outcome
  } } : {}), run: async (args, context) => {
    assertDesktopTurnNotStopped(lane)
    if (tool.name === 'file_create_copy' && folder && typeof args.name === 'string' && OUTPUT_EXTENSIONS.has(kindOf(args.name)) && !CORE_OUTPUTS.has(kindOf(args.name))) return createWide(args)
    const result = await tool.run(args, context)
    if (!/^file_(create_copy|create_workbook|edit_package)$/.test(tool.name)) return result
    const output = JSON.parse(result)
    if (output.completeReadback !== true || typeof output.path !== 'string') return result
    approved.add(output.path)
    if (!folder) return result
    try { return JSON.stringify({ ...output, taskPath: await placeTwin(paths, folder, basename(output.path).replace(REVISION, ''), await readFile(output.path), { ...placement(tool.name, args), artifact: basename(output.path) }) }) }
    catch (error) { flog('file-work', `no task copy: ${error instanceof Error ? error.message : String(error)}`); return result }
  } }))
}

const VIEWABLE = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.svg', '.py', '.js', '.ts', '.sh', '.ps1'])
const THUMBS = new Set(['.png', '.jpg', '.jpeg', '.gif'])
const VIEW_BYTES = 2_000_000
const OPENABLE = new Set(['.xlsx', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.hwpx', '.zip'])

export function registerArtifactIpc(paths: VaultPaths): void {
  ipcMain.removeHandler('artifact:read')
  ipcMain.handle('artifact:read', async (_event, id: unknown): Promise<ArtifactViewDto> => {
    const path = await findArtifact(artifactDirectory(paths), id)
    const name = basename(path).replace(/^[0-9a-f-]{36}-/, '')
    if (!VIEWABLE.has(kindOf(path)) || (await stat(path)).size > VIEW_BYTES) return { name, text: null }
    const wide = !CORE_OUTPUTS.has(kindOf(path))
    const data = wide ? await readFile(path) : await readArtifact(artifactDirectory(paths), basename(path))
    if (wide && !basename(path).startsWith(createHash('sha256').update(name).update(data).digest('hex').slice(0, 8))) throw new Error('Artifact content changed after it was saved.')
    return { name, text: data.length > VIEW_BYTES ? null : data.toString('utf8') }
  })
  ipcMain.removeHandler('artifact:reveal')
  ipcMain.handle('artifact:reveal', async (_event, id: unknown) => {
    const path = await findArtifact(artifactDirectory(paths), id)
    shell.showItemInFolder(path)
  })
  ipcMain.removeHandler('artifact:open')
  ipcMain.handle('artifact:open', async (_event, id: unknown) => {
    const path = await findArtifact(artifactDirectory(paths), id)
    if (VIEWABLE.has(kindOf(path)) && kindOf(path) !== '.html') throw new Error('Shown in the thread.')
    if (!OPENABLE.has(kindOf(path))) { shell.showItemInFolder(path); return }
    const failed = await shell.openPath(path)
    if (failed) throw new Error(failed)
  })
  ipcMain.removeHandler('artifact:info')
  ipcMain.handle('artifact:info', async (_event, id: unknown): Promise<{ size: number; previous: string[]; thumb?: { data: Uint8Array; mime: string } }> => {
    const path = await findArtifact(artifactDirectory(paths), id)
    const { size } = await stat(path), previous = await previousVersions(paths, basename(path))
    try {
      if (THUMBS.has(kindOf(path))) return { size, previous, thumb: { data: (await nativeImage.createThumbnailFromPath(path, { width: 480, height: 320 })).toPNG(), mime: 'image/png' } }
      if (kindOf(path) === '.svg' && size <= 1_000_000) return { size, previous, thumb: { data: await readFile(path), mime: 'image/svg+xml' } }
    } catch { }
    return { size, previous }
  })
}
