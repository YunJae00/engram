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
  boundedCandidates,
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

// Sweep state under .engram/ — cache, never synced.
export interface SweepState {
  last_sweep?: string
  last_j7?: string
  last_digest?: string
  last_audit?: string
  // Where the standing-corpus audit stopped: the id of the last note it
  // examined, so the next pass picks up after it instead of re-reading the
  // top of the vault forever.
  audit_cursor?: string
}

const WEEK_MS = 7 * 86_400_000
const DAY_MS = 86_400_000

// Hybrid image ingest: hand images to a vision engine when one is connected,
// keeping caller-supplied options (and any test injection) untouched.
function withVision(paths: VaultPaths, engines: Engine[], ingest: IngestOptions = {}): IngestOptions {
  return ingest.vision ? ingest : { ...ingest, vision: visionExtractor(paths, engines) }
}
// J5 processes at most this many notes per sweep (the oldest-verified first),
// so librarian cost is constant no matter how many notes expire at once. The
// remainder stay stale and re-qualify on the next sweep — nothing is dropped.
const J5_CAP = 40
// Unlinked notes that get a J2 pass per batch sweep (matches the absorb batch
// of 20, so a drained import backlog links up within a couple of sweeps).
const J2_CAP = 20
// Hub syntheses per sweep — J9 is a smart-model judgment job, so topic hubs
// refresh a few at a time, unnamed topics first (see the queue below).
const J9_CAP = 3
// Notes the standing-corpus audit re-judges per pass (see auditSlice). One J4
// call a day, so a 100-note vault is fully re-examined inside two weeks
// without the unbounded pass a whole-vault sweep would cost.
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
  // Skip the J8 briefing to save tokens during bulk absorb-drain iterations —
  // the report/idempotency behaviour is otherwise unchanged. Manual sweeps and
  // the final drain batch leave this unset so the brief still gets written.
  skipBrief?: boolean
}

export interface SweepReport extends RunReport {
  deltaCount: number
  briefWritten: boolean
}

// Incremental sweep: only the delta since last_sweep plus
// imminent-expiry notes; J7 weekly; J8 last. last_sweep is stamped with the
// sweep END time, so changes the sweep itself makes are not re-swept.
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
  // Inbox backlog first — items that realtime processing missed. Non-text
  // captures (pdf/image/url/chat paste) are converted to text before J1.
  for (const original of await listInbox(paths)) {
    const { file } = await prepareInboxItem(paths, original, ingest).catch(() => ({ file: original }))
    // still binary (e.g. audio without whisper)? it waits — never feed J1 garbage
    if (!/\.(md|txt)$/i.test(file)) continue
    jobs.push(buildJ1(paths, agentsMd, file, await readInboxFile(paths, file), now, options.autonomy))
  }
  const deltaJudged = delta.filter((n) => n.front.status === 'current' || n.front.status === 'disputed')
  const deltaCurrent = deltaJudged.filter((n) => n.front.status === 'current')
  if (deltaJudged.length > 0) {
    // One retrieval pass (index + per-target search) serves both jobs — they
    // use identical inputs and the same cap.
    const candidates = boundedCandidates(deltaJudged, corpus, 60)
    jobs.push(buildJ3(paths, agentsMd, deltaJudged, corpus, now, candidates))
    if (deltaCurrent.length > 0) jobs.push(buildJ4(paths, agentsMd, deltaCurrent, corpus, now, candidates))
  }
  const auditDue = !options.full && (!state.last_audit || now.getTime() - Date.parse(state.last_audit) >= DAY_MS)
  let auditStamp: string | undefined
  if (auditDue) {
    const slice = auditSlice(notes, new Set(delta.map((n) => n.front.id)), state.audit_cursor, AUDIT_CAP)
    if (slice.length > 0) {
      const pool = corpus.filter((n) => n.front.type !== 'hub')
      const candidates = boundedCandidates(slice, pool, 60)
      jobs.push({ ...buildJ4(paths, agentsMd, slice, pool, now, candidates), inputKey: auditInputKey(slice, candidates) })
      // Advances even if the job later defers: a rotating scan loses nothing,
      // the slice simply comes round again.
      state.audit_cursor = slice[slice.length - 1]!.front.id
    }
    // Held, not stamped: the cadence only advances if the run actually got to
    // do the work (see the guard at the end of the sweep). audit_cursor still
    // rotates unconditionally — a rotating scan loses nothing.
    auditStamp = now.toISOString()
  }
  const stale = imminentOrStale(notes, now)
  const staleBatch = oldestStale(stale, J5_CAP)
  if (staleBatch.length > 0) jobs.push(buildJ5(paths, agentsMd, staleBatch, now))
  // Incremental principle: only the delta's undetermined notes get J6 this
  // sweep — bulk imports drain through the absorb queue batch by batch.
  const undetermined = undeterminedForJ6(delta)
  if (undetermined.length > 0) jobs.push(buildJ6(paths, agentsMd, undetermined, now))
  // J7 weekly dedup: cluster near-duplicates deterministically at zero token
  // cost and only queue J7 when there is at least one candidate cluster. With
  // none we SKIP the engine call entirely but still stamp last_j7 below, so the
  // weekly cadence is respected either way.
  const j7Due = options.full || !state.last_j7 || now.getTime() - Date.parse(state.last_j7) >= WEEK_MS
  // Taught aliases widen the pairing queries AND ride the J7 prompt, so the
  // engine can both find cross-name duplicates and skip known equivalences.
  const aliasGroups = j7Due ? await loadAliasGroups(paths) : []
  const j7Clusters = j7Due && corpus.length > 1 ? findMergeClusters(corpus, aliasGroups) : []
  if (j7Clusters.length > 0) jobs.push(buildJ7(paths, agentsMd, j7Clusters, now, aliasGroups))

  // Card ids present before any job runs — the J8 brief lists only cards this
  // sweep newly raised (engine cards below plus the chronology cards after).
  const cardsBefore = new Set((await listCards(paths)).map((card) => card.id))

  const runner = new JobRunner(paths, engines, options)
  const report = await runner.runAll(jobs)

  // A deferral OR a failure must not lose absorb-queue items — put the batch
  // back. Only `deferred` was covered before, so an auth/network/timeout
  // failure (which lands in `failed`) silently dropped its 20 notes: the
  // drain loop then ate the whole import queue at full speed, every job
  // failing, and the UI still fired the "absorbed!" toast at the end.
  if ((report.deferred > 0 || report.failed.length > 0) && absorbBatch.size > 0) {
    const absorb = await loadAbsorbState(paths)
    absorb.pending = [...absorbBatch, ...absorb.pending]
    await saveAbsorbState(paths, absorb)
  }

  // The post phase (inversion cards → J2 batch → J9 → J10) runs over ONE
  // re-read of the vault: J1/J6 above may have created or re-dated notes, so
  // the boot snapshot is stale — but each step re-reading the whole vault
  // (as raiseInversionCards used to) made big vaults pay 3× per sweep.
  let postNotes = await loadNotes(paths)

  const chronologyCards = await raiseInversionCards(paths, now, postNotes)
  report.executed += chronologyCards

  const unlinked = postNotes
    .filter((n) => n.front.status === 'current' && n.front.derived_from.length === 0 && n.front.type !== 'hub')
    .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    .slice(0, J2_CAP)
  if (unlinked.length > 0) {
    const postCorpus = filterByStatus(postNotes, 'current')
    const linkReport = await runner.runAll(unlinked.map((note) => buildJ2(paths, agentsMd, note, postCorpus, now)))
    report.executed += linkReport.executed
    report.skipped += linkReport.skipped
    report.deferred += linkReport.deferred
    report.failed.push(...linkReport.failed)
    report.haltReason ??= linkReport.haltReason
    // New links change the graph J9 reads — refresh the snapshot.
    if (linkReport.executed > 0) postNotes = await loadNotes(paths)
  }

  // J9: conservative autonomy skips synthesis entirely — hubs are auto-written
  // notes, and conservative means "propose, don't write".
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

  // J12: settle the machine's own duplicate summaries before anyone is asked.
  //
  // Runs AFTER J3/J4/J7 have raised their cards and before the brief is
  // written, because the brief is where the remaining questions get listed —
  // resolving afterwards would still have shown the user a queue of twelve and
  // then quietly emptied it. Only cards whose every target is session-origin
  // are eligible: notes the user wrote are theirs, and nothing here touches
  // them (resolve.ts). The engine escalates anything it cannot settle from the
  // two bodies alone, so a question reaching the user now means it survived an
  // attempt rather than simply never having had one.
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
      // A closed loop changes what the brief reports as still open.
      if (closeReport.executed > 0) postNotes = await loadNotes(paths)
    }
  }

  // J10: weekly, and only for a week that saw activity — an idle week writes
  // nothing (idempotency), but the cadence stamp still advances below. Bulk
  // drain iterations pass skipBrief and skip the digest the same way.
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

  // J8 brief only when something actually happened — a no-op sweep stays a
  // no-op on disk (idempotency acceptance). Bulk drain iterations pass
  // skipBrief to avoid paying for a brief on every batch.
  let briefWritten = false
  if (!options.skipBrief && report.executed > 0) {
    const summary = {
      date: now.toISOString().slice(0, 10),
      // The brief leads with what the user owes, not with what the sweep did —
      // so the open loops come from the whole vault (postNotes), not the delta.
      ...openLoopsForBrief(postNotes, now),
      cards: await newCardsForBrief(paths, cardsBefore),
    }
    const briefReport = await runner.runAll([buildJ8(paths, agentsMd, summary, now)])
    briefWritten = briefReport.executed > 0
    report.executed += briefReport.executed
    report.failed.push(...briefReport.failed)
    report.haltReason ??= briefReport.haltReason
  }

  // Stamping last_sweep CONSUMES the delta: the next sweep diffs against it,
  // so a run that got nothing done would drop those notes out of every future
  // delta permanently — only the once-a-day audit slice or the vault-wide J2
  // backfill could ever reach them again, and J3/J6 never would. That is the
  // purest form of "it just stopped working", because it outlives the cause.
  // A PARTIAL failure still stamps (one bad job must not re-sweep the whole
  // vault forever); the guard is for a run that was halted or produced nothing
  // while failing — i.e. the engine, not the job, was the problem.
  const lostWork = report.deferred > 0 || report.haltReason !== undefined || (report.executed === 0 && report.failed.length > 0)
  if (!lostWork) {
    if (j7Due && corpus.length > 1) state.last_j7 = now.toISOString()
    if (auditStamp) state.last_audit = auditStamp
    state.last_sweep = new Date().toISOString()
  }
  // saveState stays unconditional so audit_cursor rotation persists either way.
  await saveState(paths, state)
  return { ...report, deltaCount: delta.length, briefWritten }
}

export function auditSlice(notes: Note[], skip: Set<string>, cursor: string | undefined, cap: number): Note[] {
  const pool = notes
    .filter((n) => n.front.status === 'current' && n.front.type !== 'hub' && !skip.has(n.front.id))
    .sort((a, b) => (a.front.id < b.front.id ? -1 : a.front.id > b.front.id ? 1 : 0))
  const after = cursor ? pool.findIndex((n) => n.front.id > cursor) : 0
  // cursor past the last id (or its note gone) → wrap to the top
  const start = after === -1 ? 0 : after
  const slice = pool.slice(start, start + cap)
  if (slice.length < cap) slice.push(...pool.slice(0, Math.min(cap - slice.length, start)))
  return slice
}

// The journal skips a job whose inputKey repeats, and buildJ4 keys on its
// TARGET ids alone. That is right for a delta (those ids only recur when the
// notes changed) and wrong for the audit, where the same slice must be
// re-judged once its neighbourhood grows. Key on both sides of the comparison:
// a pairing already judged stays free, a new neighbour re-opens it.
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
    // Default proposal: move the newer note to the day after the note it
    // supersedes; the reviewer can edit before approving.
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

// Realtime capture pipeline: J1 → J2/J3/J4/J6 for the new note.
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
    // A failed preparation (OCR crash, disk full mid-extract) must reach the
    // report — for a non-md original the extension test below skips J1, so a
    // swallowed error leaves the capture in the inbox with nothing saying
    // why. Reported as J1: preparation is the front half of absorption.
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
    for (const note of fresh) followUps.push(buildJ2(paths, agentsMd, note, corpus, now))
    const candidates = boundedCandidates(fresh, corpus, 60)
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
    // Everything still waiting, not just what one sweep produced — see
    // pendingCardsForBrief.
    cards: await pendingCardsForBrief(paths),
  }
  const runner = new JobRunner(paths, engines, options)
  const report = await runner.runAll([buildJ8(paths, await readAgentsMd(paths), summary, now)])
  return { written: report.executed > 0 }
}
