import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCard, listCards } from '../cards.js'
import type { Engine } from '../engine/types.js'
import { prepareInboxItem, visionExtractor, type IngestOptions } from '../ingest.js'
import { loadAbsorbState, saveAbsorbState, takeAbsorbBatch } from '../import.js'
import { detectInversions } from '../lineage.js'
import { buildJ12, resolvableCards } from './resolve.js'
import { buildJ13, cardedClosureTargets, closureCandidates } from './closure.js'
import { ASSOCIATION_EDGE_FLOOR, loadAnyNeighborRows, semanticEdges } from '../neighbors.js'
import { filterByStatus, loadNotes, readNote } from '../notes.js'
import type { Note } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import {
  boundedCandidatesAsync,
  buildJ1,
  buildJ2,
  buildJ3,
  buildJ4,
  buildJ5,
  buildJ6,
  buildJ7,
  buildJ8,
  imminentOrStale,
  listInbox,
  newCardsForBrief,
  oldestStale,
  openLoopsForBrief,
  pendingCardsForBrief,
  readInboxFile,
  undeterminedForJ6,
} from './librarian.js'
import { planHubJobs } from './hub.js'
import { buildJ10, digestInput } from './digest.js'
import { loadAliasGroups , loadUmbrellaTerms } from '../aliases.js'
import { findMergeClusters } from './cluster.js'
import { readAgentsMd } from './prompts.js'
import { JobRunner, type JobFailure, type RunReport, type RunnerOptions, type JobSpec } from './runner.js'

export interface SweepState {
  last_sweep?: string
  last_j7?: string
  last_digest?: string
  last_audit?: string
  audit_cursor?: string
}

const WEEK_MS = 7 * 86_400_000
const DAY_MS = 86_400_000

function withVision(paths: VaultPaths, engines: Engine[], ingest: IngestOptions = {}): IngestOptions {
  return ingest.vision ? ingest : { ...ingest, vision: visionExtractor(paths, engines) }
}
const J5_CAP = 40
const J2_CAP = 20
const J9_CAP = 3
const AUDIT_CAP = 12

export async function loadState(paths: VaultPaths): Promise<SweepState> {
  try {
    return JSON.parse(await readFile(join(paths.cache, 'state.json'), 'utf8')) as SweepState
  } catch {
    return {}
  }
}

async function saveState(paths: VaultPaths, state: SweepState): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  await writeFile(join(paths.cache, 'state.json'), JSON.stringify(state, null, 2))
}

export interface SweepOptions extends RunnerOptions {
  full?: boolean
  ingest?: import('../ingest.js').IngestOptions
  autonomy?: import('./librarian.js').Autonomy
  skipBrief?: boolean
}

export interface SweepReport extends RunReport {
  deltaCount: number
  briefWritten: boolean
}

export async function sweep(paths: VaultPaths, engines: Engine[], options: SweepOptions = {}): Promise<SweepReport> {
  const now = options.now?.() ?? new Date()
  const agentsMd = await readAgentsMd(paths)
  const state = await loadState(paths)
  const notes = await loadNotes(paths)

  const since = options.full ? null : (state.last_sweep ?? null)
  const changed = since === null ? notes : notes.filter((n) => Date.parse(n.front.updated) > Date.parse(since))
  const absorbBatch = new Set(await takeAbsorbBatch(paths, 20))
  const delta = [
    ...new Map(
      [...changed, ...notes.filter((n) => absorbBatch.has(n.front.id))].map((n) => [n.front.id, n]),
    ).values(),
  ]
  const corpus = filterByStatus(notes, 'current')

  const jobs: JobSpec[] = []
  const ingest = withVision(paths, engines, options.ingest)
  for (const original of await listInbox(paths)) {
    const { file } = await prepareInboxItem(paths, original, ingest).catch(() => ({ file: original }))
    if (!/\.(md|txt)$/i.test(file)) continue
    jobs.push(buildJ1(paths, agentsMd, file, await readInboxFile(paths, file), now, options.autonomy))
  }
  const deltaJudged = delta.filter((n) => n.front.status === 'current' || n.front.status === 'disputed')
  const deltaCurrent = deltaJudged.filter((n) => n.front.status === 'current')
  if (deltaJudged.length > 0) {
    const candidates = await boundedCandidatesAsync(deltaJudged, corpus, 60)
    jobs.push(buildJ3(paths, agentsMd, deltaJudged, corpus, now, candidates))
    if (deltaCurrent.length > 0) jobs.push(buildJ4(paths, agentsMd, deltaCurrent, corpus, now, candidates))
  }
  const auditDue = !options.full && (!state.last_audit || now.getTime() - Date.parse(state.last_audit) >= DAY_MS)
  let auditStamp: string | undefined
  if (auditDue) {
    const slice = auditSlice(notes, new Set(delta.map((n) => n.front.id)), state.audit_cursor, AUDIT_CAP)
    if (slice.length > 0) {
      const pool = corpus.filter((n) => n.front.type !== 'hub')
      const candidates = await boundedCandidatesAsync(slice, pool, 60)
      jobs.push({ ...buildJ4(paths, agentsMd, slice, pool, now, candidates), inputKey: auditInputKey(slice, candidates) })
      state.audit_cursor = slice[slice.length - 1]!.front.id
    }
    auditStamp = now.toISOString()
  }
  const stale = imminentOrStale(notes, now)
  const staleBatch = oldestStale(stale, J5_CAP)
  if (staleBatch.length > 0) jobs.push(buildJ5(paths, agentsMd, staleBatch, now))
  const undetermined = undeterminedForJ6(delta)
  if (undetermined.length > 0) jobs.push(buildJ6(paths, agentsMd, undetermined, now))
  const j7Due = options.full || !state.last_j7 || now.getTime() - Date.parse(state.last_j7) >= WEEK_MS
  const aliasGroups = j7Due ? await loadAliasGroups(paths) : []
  const j7Seeds =
    !state.last_j7 || options.full
      ? corpus
      : corpus.filter((n) => Date.parse(n.front.updated) > Date.parse(state.last_j7!))
  const j7Clusters =
    j7Due && corpus.length > 1 && j7Seeds.length > 0 ? await findMergeClusters(corpus, aliasGroups, j7Seeds) : []
  if (j7Clusters.length > 0) jobs.push(buildJ7(paths, agentsMd, j7Clusters, now, aliasGroups))

  const cardsBefore = new Set((await listCards(paths)).map((card) => card.id))

  const runner = new JobRunner(paths, engines, options)
  const report = await runner.runAll(jobs)

  if ((report.deferred > 0 || report.failed.length > 0) && absorbBatch.size > 0) {
    const absorb = await loadAbsorbState(paths)
    absorb.pending = [...absorbBatch, ...absorb.pending]
    await saveAbsorbState(paths, absorb)
  }

  let postNotes = report.executed > 0 ? await loadNotes(paths) : notes

  const chronologyCards = await raiseInversionCards(paths, now, postNotes)
  report.executed += chronologyCards

  const unlinked = postNotes
    .filter((n) => n.front.status === 'current' && n.front.derived_from.length === 0 && n.front.type !== 'hub')
    .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    .slice(0, J2_CAP)
  if (unlinked.length > 0) {
    const postCorpus = filterByStatus(postNotes, 'current')
    const j2Jobs = await Promise.all(unlinked.map((note) => buildJ2(paths, agentsMd, note, postCorpus, now)))
    const linkReport = await runner.runAll(j2Jobs)
    report.executed += linkReport.executed
    report.skipped += linkReport.skipped
    report.deferred += linkReport.deferred
    report.failed.push(...linkReport.failed)
    report.haltReason ??= linkReport.haltReason
    if (linkReport.executed > 0) postNotes = await loadNotes(paths)
  }

  if (options.autonomy !== 'conservative') {
    const known = {
      aliases: await loadAliasGroups(paths),
      umbrella: await loadUmbrellaTerms(paths),
    }
    const fabricRows = await loadAnyNeighborRows(paths)
    const fabric = fabricRows ? semanticEdges(fabricRows, ASSOCIATION_EDGE_FLOOR) : []
    const hubJobs = planHubJobs(paths, agentsMd, postNotes, now, J9_CAP, known, fabric)
    if (hubJobs.length > 0) {
      const hubReport = await runner.runAll(hubJobs)
      report.executed += hubReport.executed
      report.skipped += hubReport.skipped
      report.deferred += hubReport.deferred
      report.failed.push(...hubReport.failed)
      report.haltReason ??= hubReport.haltReason
    }
  }

  const resolvable = await resolvableCards(paths)
  if (resolvable.length > 0) {
    const resolveReport = await runner.runAll(resolvable.map((entry) => buildJ12(paths, agentsMd, entry, now)))
    report.executed += resolveReport.executed
    report.skipped += resolveReport.skipped
    report.deferred += resolveReport.deferred
    report.failed.push(...resolveReport.failed)
    report.haltReason ??= resolveReport.haltReason
  }

  {
    const closure = closureCandidates(postNotes, await cardedClosureTargets(paths), since, now)
    if (closure.loops.length > 0 && closure.conclusions.length > 0) {
      const closeReport = await runner.runAll([buildJ13(paths, agentsMd, closure, now)])
      report.executed += closeReport.executed
      report.skipped += closeReport.skipped
      report.deferred += closeReport.deferred
      report.failed.push(...closeReport.failed)
      report.haltReason ??= closeReport.haltReason
      if (closeReport.executed > 0) postNotes = await loadNotes(paths)
    }
  }

  const digestDue = options.full || !state.last_digest || now.getTime() - Date.parse(state.last_digest) >= WEEK_MS
  if (!options.skipBrief && digestDue) {
    const input = digestInput(postNotes, now)
    if (input.recent.length > 0) {
      const digestReport = await runner.runAll([buildJ10(paths, agentsMd, input, now)])
      report.executed += digestReport.executed
      report.skipped += digestReport.skipped
      report.failed.push(...digestReport.failed)
      report.haltReason ??= digestReport.haltReason
      if (digestReport.executed > 0) state.last_digest = now.toISOString()
    } else {
      state.last_digest = now.toISOString()
    }
  }

  let briefWritten = false
  if (!options.skipBrief && report.executed > 0) {
    const summary = {
      date: now.toISOString().slice(0, 10),
      ...openLoopsForBrief(postNotes, now),
      cards: await newCardsForBrief(paths, cardsBefore),
    }
    const briefReport = await runner.runAll([buildJ8(paths, agentsMd, summary, now)])
    briefWritten = briefReport.executed > 0
    report.executed += briefReport.executed
    report.failed.push(...briefReport.failed)
    report.haltReason ??= briefReport.haltReason
  }

  const lostWork = report.deferred > 0 || report.haltReason !== undefined || (report.executed === 0 && report.failed.length > 0)
  if (!lostWork) {
    if (j7Due && corpus.length > 1) state.last_j7 = now.toISOString()
    if (auditStamp) state.last_audit = auditStamp
    state.last_sweep = new Date().toISOString()
  }
  await saveState(paths, state)
  return { ...report, deltaCount: delta.length, briefWritten }
}

export function auditSlice(notes: Note[], skip: Set<string>, cursor: string | undefined, cap: number): Note[] {
  const pool = notes
    .filter((n) => n.front.status === 'current' && n.front.type !== 'hub' && !skip.has(n.front.id))
    .sort((a, b) => (a.front.id < b.front.id ? -1 : a.front.id > b.front.id ? 1 : 0))
  const after = cursor ? pool.findIndex((n) => n.front.id > cursor) : 0
  const start = after === -1 ? 0 : after
  const slice = pool.slice(start, start + cap)
  if (slice.length < cap) slice.push(...pool.slice(0, Math.min(cap - slice.length, start)))
  return slice
}

function auditInputKey(slice: Note[], candidates: Note[]): string {
  const pairing = [
    ...slice.map((n) => n.front.id).sort(),
    '|',
    ...candidates.map((n) => n.front.id).sort(),
  ].join(',')
  return `audit:${createHash('sha1').update(pairing).digest('hex').slice(0, 16)}`
}

async function raiseInversionCards(paths: VaultPaths, now: Date, notes: Note[]): Promise<number> {
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  let created = 0
  for (const inversion of detectInversions(notes)) {
    const older = byId.get(inversion.olderId)!
    const proposedDate = new Date(Date.parse(older.front.happened_at!) + 86_400_000).toISOString().slice(0, 10)
    const card = await createCard(
      paths,
      {
        cardType: 'chronology',
        targets: [inversion.newerId, inversion.olderId],
        rationale: `${inversion.newerId} supersedes ${inversion.olderId} but its happened_at is earlier`,
        proposed: JSON.stringify([{ id: inversion.newerId, happened_at: proposedDate }]),
        job: 'J6',
      },
      now,
    )
    if (card.created === now.toISOString()) created++
  }
  return created
}

export async function processCapture(
  paths: VaultPaths,
  engines: Engine[],
  options: SweepOptions = {},
): Promise<RunReport> {
  const now = options.now?.() ?? new Date()
  const agentsMd = await readAgentsMd(paths)
  const runner = new JobRunner(paths, engines, options)

  const before = new Set((await loadNotes(paths)).map((n) => n.front.id))
  const j1Jobs: JobSpec[] = []
  const prepFailures: JobFailure[] = []
  const ingest = withVision(paths, engines, options.ingest)
  for (const original of await listInbox(paths)) {
    const { file } = await prepareInboxItem(paths, original, ingest).catch((err) => {
      prepFailures.push({
        kind: 'J1',
        inputKey: `inbox/${original}`,
        error: `prepare failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return { file: original }
    })
    if (!/\.(md|txt)$/i.test(file)) continue
    j1Jobs.push(buildJ1(paths, agentsMd, file, await readInboxFile(paths, file), now, options.autonomy))
  }
  const report = await runner.runAll(j1Jobs)
  report.failed.push(...prepFailures)

  const after = await loadNotes(paths)
  const fresh: Note[] = []
  for (const note of after) {
    if (!before.has(note.front.id)) fresh.push(await readNote(paths, note.front.id))
  }
  if (fresh.length > 0) {
    const corpus = filterByStatus(after, 'current')
    const followUps: JobSpec[] = []
    for (const note of fresh) followUps.push(await buildJ2(paths, agentsMd, note, corpus, now))
    const candidates = await boundedCandidatesAsync(fresh, corpus, 60)
    followUps.push(buildJ3(paths, agentsMd, fresh, corpus, now, candidates))
    followUps.push(buildJ4(paths, agentsMd, fresh, corpus, now, candidates))
    const undated = fresh.filter((n) => !n.front.happened_at)
    if (undated.length > 0) followUps.push(buildJ6(paths, agentsMd, undated, now))
    const followReport = await runner.runAll(followUps)
    report.executed += followReport.executed
    report.skipped += followReport.skipped
    report.failed.push(...followReport.failed)
    report.deferred += followReport.deferred
  }
  return report
}

export async function refreshBrief(
  paths: VaultPaths,
  engines: Engine[],
  options: RunnerOptions = {},
): Promise<{ written: boolean }> {
  if (engines.length === 0) return { written: false }
  const now = options.now?.() ?? new Date()
  const notes = await loadNotes(paths)
  const summary = {
    date: now.toISOString().slice(0, 10),
    ...openLoopsForBrief(notes, now),
    cards: await pendingCardsForBrief(paths),
  }
  const runner = new JobRunner(paths, engines, options)
  const report = await runner.runAll([buildJ8(paths, await readAgentsMd(paths), summary, now)])
  return { written: report.executed > 0 }
}
