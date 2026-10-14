import { BrowserWindow, dialog, type WebContents } from 'electron'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { VaultPaths } from 'core'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentError } from '../shared/attachments.js'
import { saveChatAttachment } from './chat-attachments.js'

const dialogs = new Set<number>()
export const quickFileDialogOpen = (id: number): boolean => dialogs.has(id)

export async function pickQuickFiles(sender: WebContents, paths: VaultPaths, count: unknown) {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || !sender.getURL().endsWith('#quick')) throw new Error('Open the quick chat to attach files.')
  if (!Number.isInteger(count) || Number(count) < 0 || Number(count) >= ATTACHMENT_MAX_COUNT) throw new Error(`Attach up to ${ATTACHMENT_MAX_COUNT} files per message.`)
  if (dialogs.has(sender.id)) throw new Error('The file picker is already open.')
  dialogs.add(sender.id)
  try {
    const result = await dialog.showOpenDialog(window, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    if (result.filePaths.length + Number(count) > ATTACHMENT_MAX_COUNT) throw new Error(`Attach up to ${ATTACHMENT_MAX_COUNT} files per message.`)
    const files = []
    for (const path of result.filePaths) {
      const handle = await open(path, 'r')
      try {
        const stat = await handle.stat(), name = basename(path)
        if (!stat.isFile()) throw new Error('Choose a regular file.')
        const error = attachmentError(name, stat.size)
        if (error) throw new Error(error)
        const buffer = Buffer.alloc(Math.min(stat.size + 1, ATTACHMENT_MAX_BYTES + 1))
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        files.push(await saveChatAttachment(paths, name, buffer.subarray(0, size)))
      } finally { await handle.close() }
    }
    return files
  } finally {
    dialogs.delete(sender.id)
    if (!window.isDestroyed()) { window.show(); window.focus() }
  }
}
