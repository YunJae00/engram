import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeCapture } from 'core'
import { composeWorklog, readActivityRange } from './activity-watch.js'
import type { VaultContext } from './vault.js'

const DAY = 86_400_000

// Persisted journal segments, not screen contents, are filed in bounded batches.
export async function captureDeskActivity(ctx: VaultContext, now = Date.now()): Promise<boolean> {
  const directory = join(ctx.paths.workspace, '.engram')
  const cursorFile = join(directory, 'activity-capture.json')
  const until = now - 5 * 60_000
  let since = until - 7 * DAY
  try {
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8')) as { through?: number }
    if (typeof cursor.through === 'number' && Number.isFinite(cursor.through)) since = Math.max(since, Math.min(cursor.through, until))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (since >= until) return false
  const recent = await readActivityRange(ctx, since, until)
  const label = `${new Date(since).toLocaleString('en-GB')} – ${new Date(until).toLocaleString('en-GB')}`
  const log = composeWorklog(label, recent, 60_000)
  if (log) await writeCapture(ctx.paths.inbox, `${log}\n\nRecorded locally from foreground application names and window titles. This is activity evidence, not proof that a task was completed.`)
  await mkdir(directory, { recursive: true })
  await writeFile(`${cursorFile}.tmp`, JSON.stringify({ through: until }))
  await rename(`${cursorFile}.tmp`, cursorFile)
  return !!log
}
