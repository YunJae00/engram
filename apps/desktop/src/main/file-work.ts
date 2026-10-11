import { app, dialog, ipcMain, shell } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { artifactHref, fileWorkTools, workbookTool, resolveArtifact, findLocalFiles, type VaultPaths, type AgentTool, readArtifact } from 'core'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { fitImage } from './image-fit.js'
import type { ArtifactViewDto } from '../shared/types.js'

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}
export const artifactDirectory = (paths: VaultPaths) => join(paths.cache, 'artifacts')

const REVISION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i

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

export function cometFileTools(paths: VaultPaths, lane: string, attachedPaths: string[] = [], handInRoots: string[] = []) {
  const approved = new Set(attachedPaths)
  const assertReadable = async (path: string) => {
    if (within(await realpath(paths.privateDir), path)) throw new Error('Private vault files are not available to the agent.')
  }
  return [...fileWorkTools({
    directory: artifactDirectory(paths),
    handInRoots,
    assertActive: () => assertDesktopTurnNotStopped(lane),
    assertReadable,
    findFiles: (query, signal) => findLocalFiles(['documents', 'desktop', 'downloads'].map((dir) => app.getPath(dir as 'documents' | 'desktop' | 'downloads')), paths.privateDir, query, signal),
    approveRead: async (path, signal) => {
      signal?.throwIfAborted()
      await assertReadable(path)
      if (approved.has(path) && await realpath(path) === path) return true
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
  }), workbookTool(artifactDirectory(paths), () => assertDesktopTurnNotStopped(lane))].map((tool): AgentTool => ({ ...tool, ...(tool.runRich ? { runRich: async (args, context) => {
    assertDesktopTurnNotStopped(lane)
    const outcome = await tool.runRich!(args, context)
    return outcome.image ? { ...outcome, image: fitImage(outcome.image) } : outcome
  } } : {}), run: async (args, context) => {
    assertDesktopTurnNotStopped(lane)
    const result = await tool.run(args, context)
    if (tool.name === 'file_create_workbook') {
      const output = JSON.parse(result)
      if (output.completeReadback === true && typeof output.path === 'string') approved.add(output.path)
    }
    return result
  } }))
}

const VIEWABLE = new Set(['.md', '.txt', '.csv', '.tsv', '.json'])
const VIEW_BYTES = 2_000_000

export function registerArtifactIpc(paths: VaultPaths): void {
  ipcMain.removeHandler('artifact:read')
  // What the thread shows of an output file: its text, when it is text the sheet can hold.
  ipcMain.handle('artifact:read', async (_event, id: unknown): Promise<ArtifactViewDto> => {
    const path = await resolveArtifact(artifactDirectory(paths), id)
    const name = basename(path).replace(/^[0-9a-f-]{36}-/, '')
    if (!VIEWABLE.has(extname(path).toLowerCase())) return { name, text: null }
    const data = await readArtifact(artifactDirectory(paths), String(id))
    return { name, text: data.length > VIEW_BYTES ? null : data.toString('utf8') }
  })
  ipcMain.removeHandler('artifact:reveal')
  ipcMain.handle('artifact:reveal', async (_event, id: unknown) => {
    const path = await resolveArtifact(artifactDirectory(paths), id)
    // Reveal only: generated content never launches a program on a model's say-so.
    shell.showItemInFolder(path)
  })
}
