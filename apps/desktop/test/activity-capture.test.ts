import { describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureDeskActivity } from '../src/main/activity-capture.js'
import { activityWindow, readActivityRange } from '../src/main/activity-watch.js'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { initVault } from '../../../packages/core/src/vault.js'
import type { VaultContext } from '../src/main/vault.js'
import { MockEngine } from '../../../packages/core/src/engine/mock.js'
import { processCapture } from '../../../packages/core/src/jobs/sweep.js'
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
    const now = Date.now()
    const start = now - 20 * 60_000
    const directory = join(paths.workspace, '.engram', 'activity')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${new Date(start).toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ app: 'Editor', title: 'Project outline', start: new Date(start).toISOString(), end: new Date(now - 10 * 60_000).toISOString() }) + '\n')
    expect(await captureDeskActivity(ctx, now)).toBe(true)
    expect(await captureDeskActivity(ctx, now)).toBe(false)
    const files = await readdir(paths.inbox)
    expect(files).toHaveLength(1)
    expect(await readFile(join(paths.inbox, files[0]!), 'utf8')).toContain('Project outline')
    expect((await readActivityRange(ctx, start + 60_000, now))[0]?.start).toBe(new Date(start + 60_000).toISOString())
    expect(await captureDeskActivity(ctx, now + 10 * 60_000)).toBe(false)
    const engine = new MockEngine({ J1: '{"type":"note","decay":"fast","body":"# Desk activity\\n\\nProject outline was open in Editor. Completion is not verified."}', J2: '{"links":[]}', J3: '{"cards":[]}', J4: '{"cards":[]}', J6: '{"estimates":[]}' })
    expect((await processCapture(paths, [engine])).failed).toEqual([])
    const notes = await loadNotes(paths)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toContain('Project outline')
    expect(notes[0]?.front.source).toContain(files[0])
    expect(await readdir(paths.inbox)).toEqual([])
  })
})
