import { app, dialog, ipcMain, nativeImage, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { artifactHref, fileWorkTools, workbookTool, resolveArtifact, findLocalFiles, type VaultPaths, type AgentTool, readArtifact } from 'core'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { fitImage } from './image-fit.js'
import { flog } from './flog.js'
import { renderTool } from './render-file.js'
import type { ArtifactViewDto } from '../shared/types.js'

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
  // The vault is committed and synced; task files are not notes.
  await writeFile(join(taskRoot(paths), '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => { if (!exists(error)) throw error })
  await mkdir(folder, { recursive: true })
  if ((await lstat(folder)).isSymbolicLink() || !within(await realpath(paths.workspace), await realpath(folder))) throw new Error('A comet work folder cannot redirect outside this workspace.')
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
export async function linkedOutputs(directory: string, history: { role: string; text: string }[] | undefined): Promise<{ name: string; path: string }[]> {
  const latest = new Map<string, string>()
  for (const turn of history ?? []) {
    if (turn.role !== 'assistant') continue
    for (const match of turn.text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)) {
      let id: string
      try { id = decodeURIComponent(match[1]!) } catch { continue }
      const name = id.replace(REVISION, '')
      latest.delete(name)
      latest.set(name, id)
    }
  }
  const found: { name: string; path: string }[] = []
  for (const [name, id] of [...latest].slice(-40)) {
    try { found.push({ name, path: await findArtifact(directory, id) }) } catch { /* A removed or foreign file is not offered. */ }
  }
  return found
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

export function cometFileTools(paths: VaultPaths, lane: string, attachedPaths: string[] = [], handInRoots: string[] = []) {
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
  const assertReadable = async (path: string) => {
    if (within(await realpath(paths.privateDir), path)) throw new Error('Private vault files are not available to the agent.')
  }
  return [...fileWorkTools({
    directory: artifactDirectory(paths),
    handInRoots,
    assertActive: active,
    assertReadable,
    findFiles: (query, signal) => findLocalFiles(USER_FOLDERS.map((dir) => app.getPath(dir)), paths.privateDir, query, signal),
    approveRead: async (path, signal) => {
      signal?.throwIfAborted()
      await assertReadable(path)
      if (approved.has(path) && await realpath(path) === path) return true
      // The folders the comet's own file tools already read without asking.
      const real = await realpath(path)
      const roots = await Promise.all(USER_FOLDERS.map(name => realpath(app.getPath(name)).catch(() => '')))
      if (roots.some(root => root && within(root, real))) return true
      const result = await dialog.showMessageBox({
        type: 'question', buttons: ['Cancel', 'Read file'], defaultId: 0, cancelId: 0,
        message: 'Allow this chat to read this saved file?',
        detail: `${path}\n\nThe contents will be shared with your connected AI. The original file will not be changed. Unsaved application changes are not included.`,
        ...(signal ? { signal } : {}),
      })
      signal?.throwIfAborted()
      assertDesktopTurnNotStopped(lane)
      return result.response === 1
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
    if (tool.name === 'file_create_workbook') approved.add(output.path)
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
