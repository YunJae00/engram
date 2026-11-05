import { expect, it } from 'vitest'
import { initVault, loadNotes } from 'core'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { updateDailyWorklog } from '../src/main/daily-worklog.js'
it('updates one date key despite different titles, concurrent sources and repeated desk segments', async () => {
  const paths = await initVault(await tmpVaultRoot('daily-worklog'), { git: false })
  const now = new Date('2026-11-05T12:00:00Z')
  await Promise.all([
    updateDailyWorklog(paths, '2026-11-05', 'Desk', '# First title\n\nEditor 1h', now),
    updateDailyWorklog(paths, '2026-11-05', 'Web and files', '# Another title\n\nFiles A', now),
  ])
  await updateDailyWorklog(paths, '2026-11-05', 'Desk', '# Changed title\n\nEditor 2h', now)
  const notes = await loadNotes(paths)
  expect(notes).toHaveLength(1)
  expect(notes[0]?.front.id).toBe('n-worklog-2026-11-05')
  expect(notes[0]?.body).toContain('Editor 2h')
  expect(notes[0]?.body).toContain('Files A')
  expect(notes[0]?.body).not.toContain('Editor 1h')
})
