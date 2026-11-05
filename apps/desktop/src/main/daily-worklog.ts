import { createNote, readNote, writeNote, type VaultPaths } from 'core'

const writes = new Map<string, Promise<unknown>>()
export function updateDailyWorklog(paths: VaultPaths, day: string, section: 'Desk' | 'Web and files', body: string, now: Date): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid work log date')
  const id = `n-worklog-${day}`
  const key = `${paths.notes}/${id}`
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const previous = await readNote(paths, id).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    })
    const heading = `\n\n## ${section}\n`
    const text = body.replace(/^# .*\n+/, '').trim()
    if (!previous) {
      await createNote(paths, { id, body: `# Work log ${day}${heading}${text}`, type: 'note', decay: 'fast', happened_at: `${day}T00:00:00.000Z` }, now)
      return
    }
    const start = previous.body.indexOf(heading)
    const next = start < 0 ? -1 : previous.body.indexOf('\n\n## ', start + heading.length)
    if (section === 'Desk' && start >= 0) previous.body = previous.body.slice(0, start) + heading + text + (next < 0 ? '' : previous.body.slice(next))
    else previous.body += `${heading}${text}`
    previous.front.updated = now.toISOString()
    await writeNote(paths, previous)
  })
  writes.set(key, pending)
  return pending.finally(() => { if (writes.get(key) === pending) writes.delete(key) })
}
