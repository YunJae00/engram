import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changeHunks, undoChangeHunk } from 'core'
import { devEditPreview } from './dev-edit.js'
import { devGitState, runDevGit } from './dev-workspace.js'
import type { DevFileReview } from '../shared/developers.js'

export async function devFileReview(cwd: string, path: string, hooks: string): Promise<DevFileReview> {
  if (typeof path !== 'string') throw new Error('Choose a changed file.')
  const state = await devGitState(cwd, hooks), file = state.files.find(file => file.path === path)
  if (!file) throw new Error('The file is no longer changed. Refresh the review.')
  if (/[DRCU]/.test(file.status)) throw new Error('Review deleted, renamed, copied or conflicted files in your editor.')
  const preview = await devEditPreview(cwd, 'Write', { file_path: path, content: '' })
  if (!preview) throw new Error('This file cannot be reviewed safely inside the app.')
  const before = file.status === '??' ? '' : await runDevGit(cwd, ['show', `HEAD:${path}`], hooks)
  const after = preview.before
  return { path, before, after, fingerprint: createHash('sha256').update(before).update('\0').update(after).digest('hex'), hunks: changeHunks(before, after) }
}

export async function devUndoHunk(cwd: string, path: string, fingerprint: string, index: number, hooks: string, backupRoot: string): Promise<{ review: DevFileReview; backup: string }> {
  const review = await devFileReview(cwd, path, hooks)
  if (review.fingerprint !== fingerprint) throw new Error('The file changed after this preview. Refresh before discarding anything.')
  const content = undoChangeHunk(review.before, review.after, index)
  const preview = await devEditPreview(cwd, 'Write', { file_path: path, content })
  if (!preview || preview.before !== review.after) throw new Error('The file changed while preparing this action. Refresh the review.')
  const info = await stat(preview.path)
  await mkdir(backupRoot, { recursive: true })
  const backup = join(backupRoot, `${randomUUID()}.json`)
  await writeFile(backup, JSON.stringify({ path: preview.path, before: review.after, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  if (await readFile(preview.path, 'utf8') !== review.after) throw new Error('The file changed before writing. Nothing was discarded.')
  const pending = `${preview.path}.${randomUUID()}.review`
  await writeFile(pending, content, { flag: 'wx', mode: info.mode })
  // Keep the recovery file if replacement fails; never discard the only copy.
  await rename(pending, preview.path)
  const next = { ...review, after: content, fingerprint: createHash('sha256').update(review.before).update('\0').update(content).digest('hex'), hunks: changeHunks(review.before, content) }
  return { review: next, backup }
}
