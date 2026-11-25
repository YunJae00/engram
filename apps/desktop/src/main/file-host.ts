import { app, ipcMain, nativeImage, shell } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { readArtifact, type VaultPaths } from 'core'
import type { ArtifactViewDto } from '../shared/types.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { artifactDirectory, CORE_OUTPUTS, findArtifact, kindOf, previousVersions, type FileHost } from './file-work.js'
import { fitImage } from './image-fit.js'
import { renderTool } from './render-file.js'

export const appFileHost: FileHost = { app, assertDesktopTurnNotStopped, fitImage, renderTool }

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
    } catch {}
    return { size, previous }
  })
}
