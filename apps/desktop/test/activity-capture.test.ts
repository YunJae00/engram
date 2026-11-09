import { describe, expect, it } from 'vitest'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureDeskActivity } from '../src/main/activity-capture.js'
import { activityWindow, readActivityRange } from '../src/main/activity-watch.js'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { initVault } from '../../../packages/core/src/vault.js'
import type { VaultContext } from '../src/main/vault.js'
import { loadNotes } from '../../../packages/core/src/notes.js'

describe('desk activity reaches the inbox without a CLI session', () => {
  it('clips intervals without carrying prior activity into the next batch', () => {
    const spans = [{ app: 'Editor', title: 'A document', start: new Date(1000).toISOString(), end: new Date(5000).toISOString() }]
    expect(activityWindow(spans, 3000, 6000)[0]?.start).toBe(new Date(3000).toISOString())
    expect(activityWindow(spans, 5000, 6000)).toEqual([])
  })
  it('files current-day journal data once and persists its cursor', async () => {
    const paths = await initVault(await tmpVaultRoot('activity-capture'), { git: false })
    const ctx = { paths } as VaultContext
    const now = Date.UTC(2026, 10, 6, 12, 0)
    const start = now - 20 * 60_000
    const directory = join(paths.workspace, '.engram', 'activity')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${new Date(start).toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ app: 'Editor', title: 'Project outline', start: new Date(start).toISOString(), end: new Date(now - 10 * 60_000).toISOString() }) + '\n')
    expect(await captureDeskActivity(ctx, now)).toBe(true)
    expect(await captureDeskActivity(ctx, now)).toBe(false)
    expect(await readdir(paths.inbox)).toEqual([])
    expect((await readActivityRange(ctx, start + 60_000, now))[0]?.start).toBe(new Date(start + 60_000).toISOString())
    expect(await captureDeskActivity(ctx, now + 10 * 60_000)).toBe(false)
    const notes = await loadNotes(paths)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toContain('Project outline')
    expect(notes[0]?.front.id).toMatch(/^n-worklog-\d{4}-\d{2}-\d{2}$/)
    expect(await readdir(paths.inbox)).toEqual([])
  })
  it('splits a span that crosses UTC midnight between the two days it touches, filing each part once', async () => {
    const paths = await initVault(await tmpVaultRoot('activity-capture-midnight'), { git: false })
    const ctx = { paths } as VaultContext
    const now = Date.UTC(2026, 10, 7, 0, 12)
    const start = now - 20 * 60_000
    const end = now - 10 * 60_000
    const directory = join(paths.workspace, '.engram', 'activity')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '2026-11-06.jsonl'), JSON.stringify({ app: 'Editor', title: 'Project outline', start: new Date(start).toISOString(), end: new Date(end).toISOString() }) + '\n')
    expect(await readActivityRange(ctx, start, now)).toEqual([{ app: 'Editor', title: 'Project outline', start: new Date(start).toISOString(), end: new Date(end).toISOString() }])
    expect(await captureDeskActivity(ctx, now)).toBe(true)
    expect(await captureDeskActivity(ctx, now)).toBe(false)
    expect(await captureDeskActivity(ctx, now + 10 * 60_000)).toBe(false)
    const notes = (await loadNotes(paths)).sort((a, b) => a.front.id.localeCompare(b.front.id))
    expect(notes.map(note => note.front.id)).toEqual(['n-worklog-2026-11-06', 'n-worklog-2026-11-07'])
    for (const note of notes) expect(note.body).toContain('Project outline')
  })
})
