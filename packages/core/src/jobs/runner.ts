import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthError, collectResult, engineCwd, QuotaError, type Engine, type EngineId } from '../engine/types.js'
import type { VaultPaths } from '../vault.js'
import type { JobKind } from './prompts.js'

// Serial job queue: one job at a time, 5-minute timeout, one
// retry, idempotent via an input-hash journal, human-readable logs under
// _views/logs/. On quota exhaustion the remainder is deferred and the next
// installed engine substitutes for the rest of this run.
export interface JobSpec {
  kind: JobKind
  inputKey: string
  instruction: string
  prompt: string
  // Librarian jobs are data-in→JSON-out and set this so the engine runs
  // tool-free (see EngineJobInput.disallowTools). Threaded to engine.run below.
  disallowTools?: boolean
  // Per-job model tier. 'default' pins the smart model even when the run asks
  // for 'fast' — judgment jobs (supersede/conflict/merge/brief) set this: a
  // cheap model emitting a pointer instead of a real body breeds junk notes.
  // Unset inherits the run-level hint (mechanical jobs).
  modelHint?: 'fast' | 'default'
  apply(resultText: string): Promise<string[]>
}

export interface JobFailure {
  kind: JobKind
  inputKey: string
  error: string
}

export interface RunReport {
  executed: number
  skipped: number
  failed: JobFailure[]
  deferred: number
  substitutedTo?: EngineId
  // The CLI's own "when does the limit lift", when a quota message carried
  // one — the desktop's shared backoff gate waits exactly instead of guessing.
  quotaRetryAfterMs?: number
  // Why the run stopped early, when it did. Set only when there was no engine
  // left to substitute, i.e. when the deferral is something the USER has to
  // hear about: 'quota' resolves itself when the limit resets, 'auth' needs
  // them to log in again. Nothing rendered this before, which is precisely how
  // the librarian went quiet without ever saying why.
  haltReason?: 'quota' | 'auth'
}

interface Journal {
  [hash: string]: { kind: JobKind; at: string }
}

// Growth caps: the journal keeps the newest completed-job hashes (old jobs
// whose inputs changed re-run anyway), the log dir keeps the newest files.
const JOURNAL_MAX = 2000
const LOGS_MAX = 400

export function jobHash(job: Pick<JobSpec, 'kind' | 'inputKey' | 'instruction'>): string {
  return createHash('sha1').update(`${job.kind}\n${job.inputKey}\n${job.instruction}`).digest('hex')
}

export interface RunnerOptions {
  timeoutMs?: number
  now?: () => Date
  // Fired right before a job executes — for surfacing sweep progress to the
  // UI. `index` is the 1-based position of the job in the array passed to
  // runAll; `total` is jobs.length. Journal-skipped jobs never fire the hook,
  // so displayed indices can jump (that is honest). Pure: never changes runs.
  onJobStart?(job: string, index: number, total: number): void
  // Cooperative stop, checked before each job (after its journal-skip check).
  // When it returns true, the current job and every remaining job are counted
  // as deferred and the loop stops — the caller can re-queue them.
  shouldStop?(): boolean
  concurrency?: number
  // Threaded to every engine call of this run (librarian jobs → fast tier).
  modelHint?: 'fast'
  // Breather between the failed attempt and its one retry — a buffer while
  // the previous child's tree kill completes. Tests pass 0.
  retryDelayMs?: number
}

export class JobRunner {
  private timeoutMs: number
  private now: () => Date
  private onJobStart?: (job: string, index: number, total: number) => void
  private shouldStop?: () => boolean
  private concurrency: number
  private modelHint?: 'fast'
  private retryDelayMs: number

  constructor(
    private paths: VaultPaths,
    private engines: Engine[],
    options: RunnerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.now = options.now ?? (() => new Date())
    this.onJobStart = options.onJobStart
    this.shouldStop = options.shouldStop
    this.retryDelayMs = options.retryDelayMs ?? 2_000
    this.concurrency = Math.max(1, options.concurrency ?? 1)
    this.modelHint = options.modelHint
  }

  private journalPath(): string {
    return join(this.paths.cache, 'journal.json')
  }

  private async loadJournal(): Promise<Journal> {
    try {
      return JSON.parse(await readFile(this.journalPath(), 'utf8')) as Journal
    } catch {
      return {}
    }
  }

  private async saveJournal(journal: Journal): Promise<void> {
    await mkdir(this.paths.cache, { recursive: true })
    // The journal gains one entry per unique job forever — prune to the
    // newest entries so months of sweeps don't inflate every load/save.
    const entries = Object.entries(journal)
    if (entries.length > JOURNAL_MAX) {
      entries.sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      journal = Object.fromEntries(entries.slice(0, JOURNAL_MAX))
    }
    await writeFile(this.journalPath(), JSON.stringify(journal, null, 2))
  }

  // One markdown log lands per executed job and nothing ever pruned them —
  // thousands of files slow every dir scan and git add -A. Ring-buffer cap
  // (timestamped names sort chronologically).
  private async pruneLogs(): Promise<void> {
    try {
      const dir = join(this.paths.views, 'logs')
      const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
      for (const file of files.slice(0, Math.max(0, files.length - LOGS_MAX))) {
        await rm(join(dir, file), { force: true })
      }
    } catch {
      /* no logs dir yet */
    }
  }

  private async writeLog(job: JobSpec, status: string, detail: string): Promise<void> {
    const dir = join(this.paths.views, 'logs')
    await mkdir(dir, { recursive: true })
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `${stamp}-${job.kind}-${jobHash(job).slice(0, 8)}.md`)
    const content = [
      `# ${job.kind} — ${status}`,
      '',
      `- time: ${this.now().toISOString()}`,
      `- input key: ${job.inputKey}`,
      '',
      '## Output',
      '',
      detail,
      '',
    ].join('\n')
    await writeFile(file, content)
  }

  private runJob(engine: Engine, job: JobSpec): Promise<string> {
    return collectResult(engine, {
      prompt: job.prompt,
      workdir: engineCwd(this.paths),
      disallowTools: job.disallowTools,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: 120_000,
      // Judgment jobs ('default') pin the SMART tier (e.g. sonnet), never
      // the subscription's default model — that stays reserved for chat.
      // Mechanical jobs inherit the run hint (fast tier).
      modelHint: job.modelHint === 'default' ? 'smart' : (job.modelHint ?? this.modelHint),
    })
  }

  // Bounded worker pool. At concurrency 1 this IS the serial queue
  // (identical dispatch/defer/substitution behaviour); above 1 the workers pull
  // jobs off a shared cursor, so independent jobs overlap their model round
  // trips. Shared mutable state (engineIdx/halted/journal/report) is safe:
  // JS is single-threaded, mutations happen between awaits.
  async runAll(jobs: JobSpec[]): Promise<RunReport> {
    const report: RunReport = { executed: 0, skipped: 0, failed: [], deferred: 0 }
    const journal = await this.loadJournal()
    // Substitution pointer + halt flag are shared across workers: one quota
    // exhaustion moves every subsequent call to the next engine, and running
    // out of engines defers everything not yet dispatched.
    let engineIdx = 0
    let halted = false
    let next = 0

    const runOne = async (job: JobSpec, index: number): Promise<void> => {
      const hash = jobHash(job)
      // Skipped/deferred jobs never execute, so the hook only fires for jobs
      // that actually run — one call per executing job, in dispatch order.
      this.onJobStart?.(job.kind, index + 1, jobs.length)
      let done = false
      // one retry on ordinary failure
      for (let attempt = 0; attempt <= 1 && !done; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs))
        const engine = this.engines[engineIdx]
        if (!engine) {
          report.deferred++
          return
        }
        try {
          const result = await this.runJob(engine, job)
          const effects = await job.apply(result)
          journal[hash] = { kind: job.kind, at: this.now().toISOString() }
          report.executed++
          await this.writeLog(job, `done (${engine.id})`, effects.map((e) => `- ${e}`).join('\n') || '- no effects')
          done = true
        } catch (err) {
          // Quota and auth share one shape: retrying the SAME engine cannot
          // help (a limit is not lifted in 0ms, an expired login does not
          // refresh itself), so both substitute or halt instead of burning the
          // retry. Auth was previously an ordinary failure — it retried once,
          // landed in report.failed, and nothing rendered report.failed, so a
          // dead token meant 2N doomed spawns and total silence.
          if (err instanceof QuotaError || err instanceof AuthError) {
            const reason = err instanceof QuotaError ? 'quota' : 'auth'
            const note = reason === 'quota' ? 'usage limit reached' : 'login expired'
            if (err instanceof QuotaError && err.retryAfterMs !== undefined) report.quotaRetryAfterMs = err.retryAfterMs
            // Fixed substitution order: move to the next engine and retry this
            // job there; with no engine left, halt so the rest defers. The
            // identity guard advances the pointer ONCE even when several
            // concurrent jobs hit the same exhausted engine together.
            if (this.engines[engineIdx] === engine) {
              engineIdx++
              if (engineIdx < this.engines.length) {
                report.substitutedTo = this.engines[engineIdx]!.id
                await this.writeLog(job, 'engine substituted', `- ${engine.id} ${note} → switched to ${this.engines[engineIdx]!.id}`)
              } else {
                halted = true
                report.haltReason = reason
                await this.writeLog(job, 'deferred', `- ${engine.id} ${note}, no substitute engine — remaining jobs deferred`)
              }
            }
            if (engineIdx < this.engines.length) {
              attempt-- // an engine switch does not consume the retry
              continue
            }
            report.deferred++
            return
          }
          if (attempt === 1) {
            const message = err instanceof Error ? err.message : String(err)
            report.failed.push({ kind: job.kind, inputKey: job.inputKey, error: message })
            await this.writeLog(job, 'failed', `- ${message}`)
          }
        }
      }
    }

    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const i = next++
        const job = jobs[i]!
        if (journal[jobHash(job)]) {
          report.skipped++
          continue
        }
        // Cooperative stop / engine exhaustion (checked after the journal
        // skip): this job and everything still undispatched count as deferred;
        // in-flight jobs on other workers finish and are journaled normally.
        if (halted || this.shouldStop?.()) {
          report.deferred++
          continue
        }
        await runOne(job, i)
      }
    }

    const width = Math.min(this.concurrency, Math.max(1, jobs.length))
    await Promise.all(Array.from({ length: width }, () => worker()))
    await this.saveJournal(journal)
    if (report.executed > 0) await this.pruneLogs()
    return report
  }
}
