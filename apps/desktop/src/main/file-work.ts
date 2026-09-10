import { dialog, ipcMain, shell } from 'electron'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileWorkTools, workbookTool, resolveArtifact, type VaultPaths, type AgentTool } from 'core'
import { assertDesktopTurnNotStopped } from './desktop-control.js'

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}
export const artifactDirectory = (paths: VaultPaths) => join(paths.cache, 'artifacts')

export function cometFileTools(paths: VaultPaths, lane: string) {
  return [...fileWorkTools({
    directory: artifactDirectory(paths),
    assertActive: () => assertDesktopTurnNotStopped(lane),
    approveRead: async (path, signal) => {
      signal?.throwIfAborted()
      if (within(await realpath(paths.privateDir), path)) throw new Error('Private vault files are not available to the agent.')
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
  }), workbookTool(artifactDirectory(paths), () => assertDesktopTurnNotStopped(lane))].map((tool): AgentTool => ({ ...tool, run: async (args, context) => {
    assertDesktopTurnNotStopped(lane)
    return tool.run(args, context)
  } }))
}

export function registerArtifactIpc(paths: VaultPaths): void {
  ipcMain.removeHandler('artifact:reveal')
  ipcMain.handle('artifact:reveal', async (_event, id: unknown) => {
    const path = await resolveArtifact(artifactDirectory(paths), id)
    // Reveal only: generated content never launches a program on a model's say-so.
    shell.showItemInFolder(path)
  })
}
