import { app, ipcMain, nativeImage, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHref, fileWorkTools, workbookTool, resolveArtifact, findLocalFiles, type VaultPaths, type AgentTool, readArtifact } from 'core'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { fitImage } from './image-fit.js'
import { flog } from './flog.js'
import { renderTool } from './render-file.js'
import type { ArtifactViewDto } from '../shared/types.js'
import type { Ask } from './page-actions.js'
import { READ_CARD } from './read-card.js'

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}
export const artifactDirectory = (paths: VaultPaths) => join(paths.cache, 'artifacts')

const REVISION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i

export const taskRoot = (paths: VaultPaths) => join(paths.workspace, 'tasks')
export const OUTPUT_BYTES = 50_000_000
export const OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set('.pdf .docx .xlsx .pptx .csv .tsv .md .txt .json .html .png .jpg .jpeg .svg .gif .py .js .ts .sh .ps1 .zip'.split(' '))
// Core validates and reads these back itself, under its own stricter limits.
const CORE_OUTPUTS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.docx', '.pptx', '.xlsx'])
const TEXT_OUTPUTS = new Set(['.html', '.svg', '.py', '.js', '.ts', '.sh', '.ps1'])
const kindOf = (name: string) => extname(name).toLowerCase()
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'

export function outputName(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. ()-]{0,119}$/u.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || !OUTPUT_EXTENSIONS.has(kindOf(value))) throw new Error('Use a plain filename with a supported extension, without directories.')
  return value
}

export async function ensureTaskFolder(paths: VaultPaths, folder: string): Promise<string> {
  await mkdir(taskRoot(paths), { recursive: true })
  const escape = new Error('A comet work folder cannot redirect outside this workspace.')
  if ((await lstat(taskRoot(paths))).isSymbolicLink() || !within(await realpath(paths.workspace), await realpath(taskRoot(paths)))) throw escape
  // The vault is committed and synced; task files are not notes.
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

// Never overwrites: a different file of the same name gets a numbered twin.
export async function placeInTask(folder: string, name: string, data: Buffer): Promise<string> {
  outputName(name)
  const tmp = join(folder, `.${randomUUID()}.tmp`), dot = name.lastIndexOf('.')
  await writeFile(tmp, data, { flag: 'wx' })
  try {
    for (let count = 1; count < 100; count += 1) {
      const path = join(folder, count === 1 ? name : `${name.slice(0, dot)} (${count})${name.slice(dot)}`)
      try { await link(tmp, path); return path } catch (error) {
        if (!exists(error)) throw error
        const info = await lstat(path)
        if (info.isFile() && info.size === data.length && (await readFile(path)).equals(data)) return path
      }
    }
    throw new Error('Too many files in the task folder share this name.')
  } finally { await unlink(tmp).catch(() => undefined) }
}

// The first of base, base-2, base-3 ... that nothing holds yet (asked in lower case).
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
// Evidence captures (mp4, webm) are core's own kinds.
const findArtifact = (directory: string, id: unknown) => resolveOutput(directory, id).catch(() => resolveArtifact(directory, id))

// Core's priorOutputs, for the wider set of output kinds.
// every: each distinct file the text links, also two under one name (the readback gate answers for both: qa143 S19a); else the last one per name.
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
    try { found.push({ name: id.replace(REVISION, ''), path: await findArtifact(directory, id) }) } catch { /* A removed or foreign file is not offered. */ }
  }
  return found
}
// The files a turn's result check answers for: those its answer links and, on any re-check, those of the report it was given, also one the
// answer leaves out (a budget stop names none, and a check that then passed on some other read let the unread report stand: qa143 S19b).
// A re-check's answer that links a name again replaces the report's one file of that name, as its answer replaces the report. Not so when the report itself will
// stand (stands: the re-check stopped at the budget): its files are then kept, by path, whatever the turn made or linked under their names,
// so a new report.md created and read in the re-check is a second file and never the readback of the report's own.
export async function checkedOutputs(directory: string, answer: string, rechecked?: string, stands = false): Promise<{ name: string; path: string; kept?: true }[]> {
  const own = await linkedOutputs(directory, [{ role: 'assistant', text: answer }], true)
  if (rechecked === undefined) return own
  const linked = await linkedOutputs(directory, [{ role: 'assistant', text: rechecked }], true)
  // Two files the report linked under one name are two files, not revisions: a link to one of them, or to a new file of that name, replaces
  // neither of the others, so each still needs its own readback (qa143 p2 r9 S19a). Which one a new file corrects is not known; both are kept.
  const twin = (output: { name: string; path: string }) => linked.some(other => other.name === output.name && other.path !== output.path)
  const earlier = linked.filter(output => !own.some(now => stands || twin(output) ? now.path === output.path : now.name === output.name))
  return [...earlier.map(output => stands ? { ...output, kept: true as const } : output), ...own.filter(linked => !stands || !earlier.some(output => output.path === linked.path))]
}

// A check that revised a file but ran out of time still answers with the
// draft's links: each one is pointed at the newest revision of its name saved
// since the task began.
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

// Where composed files are handed in: the workspace's saved outputs (linked
// in the chat), plus a twin in the task folder when there is one.
export function taskOutputs(paths: VaultPaths, folder?: () => Promise<string | undefined>) {
  return {
    async save(name: string, data: Buffer): Promise<Record<string, unknown>> {
      const receipt = await saveOutput(artifactDirectory(paths), name, data)
      const task = await folder?.()
      if (!task) return receipt
      try { return { ...receipt, taskPath: await placeInTask(await ensureTaskFolder(paths, task), name, data) } }
      catch (error) { flog('file-work', `no task copy: ${error instanceof Error ? error.message : String(error)}`); return receipt }
    },
  }
}

// How a read outside the usual folders is put to the person: a card in the
// chat (QA 0.8.142 B6: an app-modal dialog froze the whole app for minutes).
export interface ReadConsent { ask?: Ask; korean?: () => boolean }

export function cometFileTools(paths: VaultPaths, lane: string, attachedPaths: string[] = [], handInRoots: string[] = [], consent: ReadConsent = {}) {
  const approved = new Set(attachedPaths)
  const directory = artifactDirectory(paths), folder = handInRoots[0]
  const active = () => assertDesktopTurnNotStopped(lane)
  const save = async (name: string, data: Buffer) => {
    const receipt = await saveOutput(directory, name, data)
    approved.add(receipt.path)
    return { ...receipt, taskPath: await placeInTask(await ensureTaskFolder(paths, folder!), name, data) }
  }
  // Kinds core does not hold (scripts, HTML, images, PDF, ZIP) are saved by the host.
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
    return JSON.stringify(await save(name, data))
  }
  // This task's folders, each checked to be a real folder (not a link) inside
  // the workspace's task folders; core hands in from these alone (codex p1 r3).
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
      if (approved.has(path) && await realpath(path) === path) return true
      const real = await realpath(path)
      // This task's folder: files the comet built itself, which its own file
      // tools also read without asking. Its handed-in outputs are in `approved`.
      // A folder that is a link or leads out of the workspace's task folders is not trusted.
      if ((await ownRoots()).some(root => within(root, real))) return true
      // The folders the comet's own file tools already read without asking.
      const roots = await Promise.all(USER_FOLDERS.map(name => realpath(app.getPath(name)).catch(() => '')))
      if (roots.some(root => root && within(root, real))) return true
      // Anything else is asked in the chat; with no chat to ask in, it is not read.
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
  }), workbookTool(directory, active), ...(folder ? [renderTool({ folder: () => ensureTaskFolder(paths, folder), source: async (path) => taskFile(paths, await ensureTaskFolder(paths, folder), path), save, assertActive: active })] : [])].map((tool): AgentTool => ({ ...tool, ...(tool.name === 'file_create_copy' && folder ? { description: `${tool.description} With content or fromPath it also saves HTML, SVG and scripts (py, js, ts, sh, ps1); with fromPath also PDF, PNG, JPG, GIF and ZIP built in the task folder, up to 50 MB.` } : {}), ...(tool.runRich ? { runRich: async (args, context) => {
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
    // The comet may read back any output it just handed in (QA 0.8.142 B6: re-reading its own copy asked and froze the app).
    approved.add(output.path)
    if (!folder) return result
    // The linked copy is the verified output; the task-folder twin is for combining work.
    try { return JSON.stringify({ ...output, taskPath: await placeInTask(await ensureTaskFolder(paths, folder), basename(output.path).replace(REVISION, ''), await readFile(output.path)) }) }
    catch (error) { flog('file-work', `no task copy: ${error instanceof Error ? error.message : String(error)}`); return result }
  } }))
}

const VIEWABLE = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.svg', '.py', '.js', '.ts', '.sh', '.ps1'])
const THUMBS = new Set(['.png', '.jpg', '.jpeg', '.gif'])
const VIEW_BYTES = 2_000_000
const OPENABLE = new Set(['.xlsx', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.hwpx', '.zip'])

export function registerArtifactIpc(paths: VaultPaths): void {
  ipcMain.removeHandler('artifact:read')
  // What the thread shows of an output file: its text, when it is text the sheet can hold.
  ipcMain.handle('artifact:read', async (_event, id: unknown): Promise<ArtifactViewDto> => {
    const path = await findArtifact(artifactDirectory(paths), id)
    const name = basename(path).replace(/^[0-9a-f-]{36}-/, '')
    if (!VIEWABLE.has(kindOf(path)) || (await stat(path)).size > VIEW_BYTES) return { name, text: null }
    const wide = !CORE_OUTPUTS.has(kindOf(path))
    const data = wide ? await readFile(path) : await readArtifact(artifactDirectory(paths), String(id))
    if (wide && !String(id).startsWith(createHash('sha256').update(name).update(data).digest('hex').slice(0, 8))) throw new Error('Artifact content changed after it was saved.')
    return { name, text: data.length > VIEW_BYTES ? null : data.toString('utf8') }
  })
  ipcMain.removeHandler('artifact:reveal')
  ipcMain.handle('artifact:reveal', async (_event, id: unknown) => {
    const path = await findArtifact(artifactDirectory(paths), id)
    // Reveal only: a model's say-so never launches a program.
    shell.showItemInFolder(path)
  })
  ipcMain.removeHandler('artifact:open')
  // Opened only on the person's click, and only kinds that carry no code of
  // their own; anything else is shown in its folder.
  ipcMain.handle('artifact:open', async (_event, id: unknown) => {
    const path = await findArtifact(artifactDirectory(paths), id)
    // Scripts and markup are shown as text in the thread, never handed to a program that could run them.
    if (VIEWABLE.has(kindOf(path)) && kindOf(path) !== '.html') throw new Error('Shown in the thread.')
    if (!OPENABLE.has(kindOf(path))) { shell.showItemInFolder(path); return }
    const failed = await shell.openPath(path)
    if (failed) throw new Error(failed)
  })
  ipcMain.removeHandler('artifact:info')
  ipcMain.handle('artifact:info', async (_event, id: unknown): Promise<{ size: number; thumb?: { data: Uint8Array; mime: string } }> => {
    const path = await findArtifact(artifactDirectory(paths), id)
    const { size } = await stat(path)
    try {
      if (THUMBS.has(kindOf(path))) return { size, thumb: { data: (await nativeImage.createThumbnailFromPath(path, { width: 480, height: 320 })).toPNG(), mime: 'image/png' } }
      // Shown through an img element, where SVG script is inert.
      if (kindOf(path) === '.svg' && size <= 1_000_000) return { size, thumb: { data: await readFile(path), mime: 'image/svg+xml' } }
    } catch { /* A card without a picture still shows its size. */ }
    return { size }
  })
}
