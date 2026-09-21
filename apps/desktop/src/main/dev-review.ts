import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changeHunks, undoChangeHunk } from 'core'
import { devEditPreview } from './dev-edit.js'
import { devGitState, runDevGit } from './dev-workspace.js'
import type { DevFileReview } from '../shared/developers.js'
import { devTaskFileReview } from './dev-baseline.js'

export async function devFileReview(cwd: string, path: string, hooks: string): Promise<DevFileReview> {
  if (typeof path !== 'string') throw new Error('Choose a changed file.')
  const state = await devGitState(cwd, hooks), file = state.files.find(file => file.path === path)
  if (!file) throw new Error('The file is no longer changed. Refresh the review.')
  if (/U/.test(file.status) || ['AA', 'DD'].includes(file.status)) throw new Error('Ask the agent to resolve this merge conflict before reviewing individual hunks.')
  const preview = await devEditPreview(cwd, 'Write', { file_path: path, content: '' })
  if (!preview) throw new Error('This file cannot be reviewed safely inside the app.')
  const before = file.status === '??' || file.status.startsWith('A') ? '' : await runDevGit(cwd, ['show', `HEAD:${file.previousPath ?? path}`], hooks)
  const after = file.status.includes('D') ? '' : preview.before
  if (before.includes('\0') || after.includes('\0') || before.length > 500_000) throw new Error('Binary or large files cannot be shown as a text diff.')
  return { path, before, after, readOnly: /[DRC]/.test(file.status), fingerprint: createHash('sha256').update(before).update('\0').update(after).digest('hex'), hunks: changeHunks(before, after) }
}

export async function devUndoHunk(cwd: string, path: string, fingerprint: string, index: number, hooks: string, backupRoot: string): Promise<{ review: DevFileReview; backup: string }> {
  const review = await devFileReview(cwd, path, hooks)
  return undoReview(cwd, review, fingerprint, index, backupRoot)
}

export async function devUndoTaskHunk(root: string, id: string, cwd: string, path: string, fingerprint: string, index: number, backupRoot: string): Promise<{ review: DevFileReview; backup: string }> {
  return undoReview(cwd, await devTaskFileReview(root, id, cwd, path), fingerprint, index, backupRoot)
}

async function undoReview(cwd: string, review: DevFileReview, fingerprint: string, index: number, backupRoot: string): Promise<{ review: DevFileReview; backup: string }> {
  const path = review.path
  if (review.readOnly) throw new Error('This preview cannot safely restore file identity. Ask the agent to review this change instead.')
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
