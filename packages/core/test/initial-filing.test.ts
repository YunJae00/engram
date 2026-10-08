import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { writeCapture } from '../src/capture.js'
import type { Engine, EngineJobInput } from '../src/engine/types.js'
import { loadAbsorbState, saveAbsorbState } from '../src/import.js'
import { prepareInitialFiling, type InitialFilingStage } from '../src/jobs/initial-filing.js'
import { loadState } from '../src/jobs/sweep.js'
import { createNote, loadNotes, readNote, writeNote } from '../src/notes.js'
import { serializeNote } from '../src/schema.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

let paths: VaultPaths
const prompts: string[] = []
const kind = (prompt: string) => /^JOB: (\w+)/.exec(prompt)![1]!
function engine(handle?: (job: EngineJobInput) => Promise<string | undefined>): Engine {
  return {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    async *run(job) {
      prompts.push(job.prompt)
      const text = await handle?.(job)
      yield { type: 'result', text: text ?? (kind(job.prompt) === 'J1' ? JSON.stringify({ body: '# Captured work\n\nKnown task', type: 'note', decay: 'slow' }) : '{"links":[],"cards":[],"estimates":[]}') }
    },
  }
}

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('initial-filing'), { git: false })
  prompts.length = 0
})

it('finishes a fixed snapshot, reports each finite phase, and leaves ongoing sweep state alone', async () => {
  const first = await createNote(paths, { id: 'n-known-0001', body: '# Known purchasing work' })
  await writeCapture(paths.inbox, 'Known captured task')
  await saveAbsorbState(paths, { pending: [first.front.id], total: 1 })
  const progress: Array<[number, number, InitialFilingStage]> = []
  let arrived = false
  const report = await prepareInitialFiling(paths, [engine(async job => {
    if (!arrived && kind(job.prompt) === 'J1') {
      arrived = true
      await createNote(paths, { id: 'n-later-0001', body: '# LATE_EXTERNAL_NOTE' })
      await writeCapture(paths.inbox, 'LATE_EXTERNAL_CAPTURE')
    }
    return undefined
  })], { onProgress: (...event) => progress.push(event), retryDelayMs: 0 })
  expect(report.failed).toEqual([])
  expect(report.deferred).toBe(0)
  expect(report.noteIds).toContain(first.front.id)
  expect(report.noteIds).not.toContain('n-later-0001')
  expect(report.noteIds).toHaveLength(2)
  expect(prompts.join('\n')).not.toMatch(/LATE_EXTERNAL_/)
  expect(prompts.some(prompt => prompt.includes('Captured work') && kind(prompt) === 'J2')).toBe(true)
  expect((await readdir(paths.inbox))).toHaveLength(1)
  expect(await loadAbsorbState(paths)).toEqual({ pending: [first.front.id], total: 1 })
  expect(await loadState(paths)).toEqual({})
  for (const stage of ['capture', 'organize'] as const) {
    const events = progress.filter(event => event[2] === stage)
    expect(events[0]?.[0]).toBe(0)
    expect(new Set(events.map(event => event[1])).size).toBe(1)
    expect(events.at(-1)?.[0]).toBe(events.at(-1)?.[1])
  }
})

it('does not send work-map notes or linked descendants without consent', async () => {
  await createNote(paths, { id: 'n-place-portal', type: 'place', body: '# BROWSER_PRIVATE_PLACE' })
  await createNote(paths, { id: 'n-child-0001', body: '# PRIVATE_CHILD', derived_from: ['n-place-portal'] })
  await createNote(paths, { id: 'n-grandchild-0001', body: '# PRIVATE_GRANDCHILD', derived_from: ['n-child-0001'] })
  await createNote(paths, { id: 'n-allowed-0001', body: '# Permitted work' })
  const report = await prepareInitialFiling(paths, [engine()], { retryDelayMs: 0 })
  expect(report.noteIds).toEqual(['n-allowed-0001'])
  expect(prompts.join('\n')).not.toMatch(/PRIVATE/)
  prompts.length = 0
  const allowed = await prepareInitialFiling(paths, [engine()], { includeWorkMap: true, retryDelayMs: 0 })
  expect(allowed.noteIds).toHaveLength(4)
  expect(prompts.join('\n')).toContain('BROWSER_PRIVATE_PLACE')
})

it('reports unsupported captures without losing their contents or claiming completion', async () => {
  await writeFile(join(paths.inbox, 'unreadable.blob'), 'original bytes')
  const report = await prepareInitialFiling(paths, [engine()])
  expect(report.failed).toHaveLength(1)
  expect(report.failed[0]?.error).toContain('could not be read')
  expect(await readFile(join(paths.inbox, 'unreadable.blob'), 'utf8')).toBe('original bytes')
  expect(prompts).toEqual([])
})

it('keeps a capture edited while the model was responding', async () => {
  const capture = await writeCapture(paths.inbox, 'Original task')
  const report = await prepareInitialFiling(paths, [engine(async () => {
    await writeFile(join(paths.inbox, capture.file), 'Changed task')
    return undefined
  })], { retryDelayMs: 0 })
  expect(report.failed).toHaveLength(1)
  expect(report.failed[0]?.error).toContain('capture changed')
  expect(await readFile(join(paths.inbox, capture.file), 'utf8')).toBe('Changed task')
  expect(await loadNotes(paths)).toEqual([])
})

it('never applies a late response after cancellation and can resume completed capture work', async () => {
  await writeFile(join(paths.inbox, 'a.md'), 'First capture')
  await writeFile(join(paths.inbox, 'b.md'), 'Second capture')
  const abort = new AbortController()
  let captures = 0
  await expect(prepareInitialFiling(paths, [engine(async job => {
    if (kind(job.prompt) === 'J1' && ++captures === 2) abort.abort()
    return undefined
  })], { signal: abort.signal, retryDelayMs: 0 })).rejects.toMatchObject({ name: 'AbortError' })
  expect(await readdir(paths.inbox)).toEqual(['b.md'])
  expect(await loadNotes(paths)).toHaveLength(1)
  expect(Object.keys(JSON.parse(await readFile(join(paths.cache, 'journal.json'), 'utf8')))).toHaveLength(1)
  prompts.length = 0
  const resumed = await prepareInitialFiling(paths, [engine()], { retryDelayMs: 0 })
  expect(resumed.failed).toEqual([])
  expect(resumed.noteIds).toHaveLength(2)
  expect(prompts.filter(prompt => kind(prompt) === 'J1')).toHaveLength(1)
  expect(await readdir(paths.inbox)).toEqual([])
})

it('rejects a model reference to a note arriving outside the snapshot', async () => {
  await createNote(paths, { id: 'n-known-0001', body: '# Known work' })
  await createNote(paths, { id: 'n-known-0002', body: '# Other known work' })
  let arrived = false
  const report = await prepareInitialFiling(paths, [engine(async job => {
    if (!arrived) { arrived = true; await createNote(paths, { id: 'n-later-0001', body: '# Later task' }) }
    if (kind(job.prompt) === 'J3') return '{"cards":[{"cardType":"conflict","targets":["n-known-0001","n-later-0001"],"rationale":"test"}]}'
    return undefined
  })], { retryDelayMs: 0 })
  expect(report.failed.some(failure => failure.error.includes('outside this preparation'))).toBe(true)
  expect((await readNote(paths, 'n-later-0001')).front.status).toBe('current')
})

it('preserves a note edited during filing and reports the incomplete job', async () => {
  await createNote(paths, { id: 'n-known-0001', body: '# Original work' })
  await createNote(paths, { id: 'n-known-0002', body: '# Other original work' })
  const report = await prepareInitialFiling(paths, [engine(async job => {
    if (kind(job.prompt) === 'J2') {
      const note = await readNote(paths, 'n-known-0001')
      await writeNote(paths, { ...note, body: '# User edit' })
    }
    return undefined
  })], { retryDelayMs: 0 })
  expect(report.failed.some(failure => failure.error.includes('note changed'))).toBe(true)
  expect((await readNote(paths, 'n-known-0001')).body).toBe('# User edit\n')
})

it('refuses inbox junctions without reading their targets', async () => {
  const outside = join(paths.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_CONTENT')
  await symlink(outside, join(paths.inbox, 'linked.md'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(prepareInitialFiling(paths, [engine()])).rejects.toThrow('regular files')
  expect(prompts).toEqual([])
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('OUTSIDE_CONTENT')
})

it('reports quota deferral and preserves the inbox for a later attempt', async () => {
  const capture = await writeCapture(paths.inbox, 'Keep this for later')
  const limited: Engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'error', message: '429 rate limit' } },
  }
  const report = await prepareInitialFiling(paths, [limited])
  expect(report.haltReason).toBe('quota')
  expect(report.deferred).toBe(1)
  expect(await readFile(join(paths.inbox, capture.file), 'utf8')).toContain('Keep this')
})

it('does not spend model calls on relationships without a second note', async () => {
  await createNote(paths, { id: 'n-known-0001', body: '# Known work', happened_at: '2026-10-01' })
  const report = await prepareInitialFiling(paths, [engine()])
  expect(report.noteIds).toEqual(['n-known-0001'])
  expect(report.executed).toBe(0)
  expect(prompts).toEqual([])
})

it('rejects an ID changed while the model ran without overwriting another note', async () => {
  await createNote(paths, { id: 'n-known-0001', body: '# Original work' })
  await createNote(paths, { id: 'n-known-0002', body: '# Related work' })
  let changed = false
  const report = await prepareInitialFiling(paths, [engine(async job => {
    if (!changed && kind(job.prompt) === 'J2') {
      changed = true
      await createNote(paths, { id: 'n-outside-0001', body: '# Must survive' })
      const note = await readNote(paths, 'n-known-0001')
      await writeFile(join(paths.notes, 'n-known-0001.md'), serializeNote({ ...note, front: { ...note.front, id: 'n-outside-0001' } }))
    }
    return kind(job.prompt) === 'J2' ? '{"links":[{"id":"n-known-0002","reason":"Related work"}]}' : undefined
  })], { retryDelayMs: 0 })
  expect(report.failed.some(failure => failure.error.includes('note changed'))).toBe(true)
  expect((await readNote(paths, 'n-outside-0001')).body).toContain('Must survive')
})

it.each(['unknown', '2026-02-31'])('refuses invalid event date %s without making the note unreadable', async date => {
  await createNote(paths, { id: 'n-known-0001', body: '# Undated work' })
  const before = await readFile(join(paths.notes, 'n-known-0001.md'), 'utf8')
  const report = await prepareInitialFiling(paths, [engine(async job => kind(job.prompt) === 'J6'
    ? JSON.stringify({ estimates: [{ id: 'n-known-0001', happened_at: date }] }) : undefined)], { retryDelayMs: 0 })
  expect(report.failed.some(failure => failure.error.includes('invalid event date'))).toBe(true)
  expect(await readFile(join(paths.notes, 'n-known-0001.md'), 'utf8')).toBe(before)
  expect(await loadNotes(paths)).toHaveLength(1)
})

it('bounds reconciliation batches and candidate context without expanding the snapshot', async () => {
  for (let at = 0; at < 65; at++) await createNote(paths, { id: `n-item-${String(at).padStart(4, '0')}`, body: `# Work item ${at}\nShared purchasing context`, happened_at: '2026-10-01' })
  const report = await prepareInitialFiling(paths, [engine()], { retryDelayMs: 0 })
  expect(report.failed).toEqual([])
  expect(report.noteIds).toHaveLength(65)
  const reconciliations = prompts.filter(prompt => ['J3', 'J4'].includes(kind(prompt)))
  expect(reconciliations).toHaveLength(8)
  for (const prompt of reconciliations) {
    const input = JSON.parse(prompt.split('--- INPUT ---').at(-1)!.replace(/^\s*```json\s*/, '').replace(/\s*```\s*$/, ''))
    expect(input.changed.length).toBeLessThanOrEqual(20)
    expect(input.corpus.length).toBeLessThanOrEqual(60)
    expect(input.corpus.length).toBeGreaterThan(0)
  }
})
