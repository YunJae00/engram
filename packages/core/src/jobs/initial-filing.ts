import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { extractJson, type Engine } from '../engine/types.js'
import { prepareInboxItem, type IngestOptions } from '../ingest.js'
import { notePath, readNote } from '../notes.js'
import { parseNote, type Note } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { PLACE_TYPE } from '../work-map.js'
import { boundedCandidatesAsync, buildJ1, buildJ2, buildJ3, buildJ4, buildJ6, undeterminedForJ6 } from './librarian.js'
import { readAgentsMd } from './prompts.js'
import { JobRunner, type JobSpec, type RunReport, type RunnerOptions } from './runner.js'

export type InitialFilingStage = 'capture' | 'organize'
export interface InitialFilingOptions extends RunnerOptions {
  includeWorkMap?: boolean
  ingest?: IngestOptions
  onProgress?(completed: number, total: number, stage: InitialFilingStage): void
}
export interface InitialFilingReport extends RunReport {
  noteIds: string[]
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

async function localFile(file: string): Promise<Buffer> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Initial filing only reads regular files inside this workspace.')
  return readFile(file)
}

async function names(folder: string): Promise<string[]> {
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Initial filing needs a local workspace directory.')
  return (await readdir(folder)).filter(name => !name.startsWith('.')).sort()
}

function permitted(notes: Note[], includeWorkMap: boolean): Note[] {
  const excluded = new Set(notes.filter(note => !includeWorkMap && (note.front.type === PLACE_TYPE || note.front.id.startsWith('n-place-'))).map(note => note.front.id))
  for (let changed = true; changed;) {
    changed = false
    for (const note of notes) {
      if (!excluded.has(note.front.id) && note.front.derived_from.some(id => excluded.has(id))) {
        excluded.add(note.front.id)
        changed = true
      }
    }
  }
  return notes.filter(note => note.front.status === 'current' && !excluded.has(note.front.id))
}

// The host owns the filing lock. New captures and notes are left for another pass.
export async function prepareInitialFiling(paths: VaultPaths, engines: Engine[], options: InitialFilingOptions = {}): Promise<InitialFilingReport> {
  const signal = options.signal
  signal?.throwIfAborted()
  const report: InitialFilingReport = { executed: 0, skipped: 0, failed: [], deferred: 0, noteIds: [] }
  const [noteNames, inboxNames, agents] = await Promise.all([names(paths.notes), names(paths.inbox), readAgentsMd(paths)])
  const notes: Note[] = []
  for (const name of noteNames.filter(name => name.endsWith('.md'))) {
    signal?.throwIfAborted()
    const note = parseNote((await localFile(join(paths.notes, name))).toString('utf8'))
    if (notePath(paths, note.front.id) !== join(paths.notes, name)) throw new Error('A note filename does not match its ID; it was kept unchanged.')
    notes.push(note)
  }
  const captured: Array<{ name: string; hash: string }> = []
  for (const name of inboxNames) {
    signal?.throwIfAborted()
    captured.push({ name, hash: digest(await localFile(join(paths.inbox, name))) })
  }
  const current = permitted(notes, options.includeWorkMap === true)
  report.noteIds = current.map(note => note.front.id)
  const created: string[] = []
  const now = options.now?.() ?? new Date()
  const run = async (jobs: JobSpec[], stage: InitialFilingStage) => {
    signal?.throwIfAborted()
    let completed = 0
    options.onProgress?.(0, jobs.length, stage)
    const one = await new JobRunner(paths, engines, {
      ...options, concurrency: 1,
      onJobDone: (job, index, total) => {
        options.onJobDone?.(job, index, total)
        options.onProgress?.(++completed, total, stage)
      },
    }).runAll(jobs)
    report.executed += one.executed
    report.skipped += one.skipped
    report.failed.push(...one.failed)
    report.deferred += one.deferred
    report.haltReason ??= one.haltReason
    report.substitutedTo ??= one.substitutedTo
    report.quotaRetryAfterMs ??= one.quotaRetryAfterMs
    signal?.throwIfAborted()
    return !one.failed.length && !one.deferred && !one.haltReason
  }

  const captures: JobSpec[] = []
  for (const entry of captured) {
    signal?.throwIfAborted()
    try {
      if (digest(await localFile(join(paths.inbox, entry.name))) !== entry.hash) throw new Error('The capture changed during preparation; try again to include the latest version.')
      const prepared = await prepareInboxItem(paths, entry.name, options.ingest)
      signal?.throwIfAborted()
      if (!/\.(md|txt)$/i.test(prepared.file)) throw new Error('This capture could not be read yet; the original was kept.')
      const file = join(paths.inbox, prepared.file)
      const content = (await localFile(file)).toString('utf8')
      const job = buildJ1(paths, agents, prepared.file, content, now)
      captures.push({ ...job, apply: async result => {
        signal?.throwIfAborted()
        if ((await localFile(file)).toString('utf8') !== content) throw new Error('The capture changed while filing; the newer version was kept.')
        signal?.throwIfAborted()
        const effects = await job.apply(result)
        // Only IDs returned by our capture jobs belong to this snapshot.
        for (const effect of effects) {
          const id = /^note created: (\S+) \(/.exec(effect)?.[1]
          if (id) { created.push(id); report.noteIds.push(id) }
        }
        return effects
      } })
    } catch (error) {
      signal?.throwIfAborted()
      report.failed.push({ kind: 'J1', inputKey: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (report.failed.length || !await run(captures, 'capture')) return report
  for (const id of created) current.push(await readNote(paths, id))
  signal?.throwIfAborted()
  if (!current.length) { options.onProgress?.(0, 0, 'organize'); return report }

  const byId = new Map(current.map(note => [note.front.id, note]))
  const scopeHash = digest(JSON.stringify(current.map(note => [note.front.id, note.body]).sort((a, b) => a[0]!.localeCompare(b[0]!))))
  const guarded = (job: JobSpec, ownTarget?: string): JobSpec => ({
    ...job, inputKey: `initial:${scopeHash}:${job.inputKey}`,
    apply: async result => {
      signal?.throwIfAborted()
      const parsed = extractJson(result) as { cards?: Array<{ targets?: string[] }>; estimates?: Array<{ id: string; happened_at?: unknown }> }
      if (job.kind === 'J6' && (parsed.estimates ?? []).some(estimate => {
        const date = estimate.happened_at
        return typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
      })) throw new Error('The model returned an invalid event date; the original notes were kept.')
      const targets = ownTarget ? [ownTarget] : job.kind === 'J6' ? (parsed.estimates ?? []).map(estimate => estimate.id) : (parsed.cards ?? []).flatMap(card => card.targets ?? [])
      for (const id of new Set(targets)) {
        const original = byId.get(id)
        if (!original) throw new Error('The filing result referred to a note outside this preparation.')
        const latest = parseNote((await localFile(notePath(paths, id))).toString('utf8'))
        if (latest.front.id !== id || latest.body !== original.body || !['current', 'disputed'].includes(latest.front.status)) throw new Error('A note changed while filing; its edits were kept. Try again.')
      }
      signal?.throwIfAborted()
      return job.apply(result)
    },
  })
  const targets = current.filter(note => note.front.type !== 'hub')
  const jobs = current.length > 1 ? await Promise.all(targets.map(async note => guarded(await buildJ2(paths, agents, note, current, now), note.front.id))) : []
  // Keep within-batch comparisons while bounding both targets and retrieved neighbours.
  if (current.length > 1) for (let at = 0; at < targets.length; at += 20) {
    signal?.throwIfAborted()
    const batch = targets.slice(at, at + 20)
    const candidates = [...batch, ...await boundedCandidatesAsync(batch, current, 60 - batch.length)]
    jobs.push(guarded(buildJ3(paths, agents, batch, current, now, candidates)), guarded(buildJ4(paths, agents, batch, current, now, candidates)))
  }
  const undated = undeterminedForJ6(targets)
  for (let at = 0; at < undated.length; at += 20) jobs.push(guarded(buildJ6(paths, agents, undated.slice(at, at + 20), now)))
  await run(jobs, 'organize')
  return report
}
