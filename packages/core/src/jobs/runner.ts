import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthError, collectResult, engineCwd, OutageError, QuotaError, type Engine, type EngineId } from '../engine/types.js'
import type { VaultPaths } from '../vault.js'
import type { JobKind } from './prompts.js'

export interface JobSpec {
  kind: JobKind
  inputKey: string
  instruction: string
  prompt: string
  disallowTools?: boolean
  jsonSchema?: unknown
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
  quotaRetryAfterMs?: number
  haltReason?: 'quota' | 'auth' | 'outage'
}

interface Journal {
  [hash: string]: { kind: JobKind; at: string }
}

const JOURNAL_MAX = 2000
const LOGS_MAX = 400

export function jobHash(job: Pick<JobSpec, 'kind' | 'inputKey' | 'instruction'>): string {
  return createHash('sha1').update(`${job.kind}\n${job.inputKey}\n${job.instruction}`).digest('hex')
}

export interface RunnerOptions {
  timeoutMs?: number
  now?: () => Date
  onJobStart?(job: string, index: number, total: number): void
  onJobDone?(job: string, index: number, total: number): void
  signal?: AbortSignal
  shouldStop?(): boolean
  concurrency?: number
  modelHint?: 'fast'
  retryDelayMs?: number
}

export class JobRunner {
  private timeoutMs: number
  private now: () => Date
  private onJobStart?: (job: string, index: number, total: number) => void
  private onJobDone?: (job: string, index: number, total: number) => void
  private signal?: AbortSignal
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
    this.onJobDone = options.onJobDone
    this.signal = options.signal
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
    const entries = Object.entries(journal)
    if (entries.length > JOURNAL_MAX) {
      entries.sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      journal = Object.fromEntries(entries.slice(0, JOURNAL_MAX))
    }
    await writeFile(this.journalPath(), JSON.stringify(journal, null, 2))
  }

  private async pruneLogs(): Promise<void> {
    try {
      const dir = join(this.paths.views, 'logs')
      const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
      for (const file of files.slice(0, Math.max(0, files.length - LOGS_MAX))) {
        await rm(join(dir, file), { force: true })
      }
    } catch {
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
      ...(job.jsonSchema ? { jsonSchema: job.jsonSchema } : {}),
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: 120_000,
      signal: this.signal,
      modelHint: job.modelHint === 'default' ? 'smart' : (job.modelHint ?? this.modelHint),
    })
  }

  async runAll(jobs: JobSpec[]): Promise<RunReport> {
    const report: RunReport = { executed: 0, skipped: 0, failed: [], deferred: 0 }
    const journal = await this.loadJournal()
    let engineIdx = 0
    let halted = false
    let next = 0

    const runOne = async (job: JobSpec, index: number): Promise<void> => {
      const hash = jobHash(job)
      this.onJobStart?.(job.kind, index + 1, jobs.length)
      let done = false
      for (let attempt = 0; attempt <= 1 && !done; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs))
        if (this.signal?.aborted) { report.deferred++; return }
        const engine = this.engines[engineIdx]
        if (!engine) {
          report.deferred++
          return
        }
        try {
          const result = await this.runJob(engine, job)
          this.signal?.throwIfAborted()
          const effects = await job.apply(result)
          journal[hash] = { kind: job.kind, at: this.now().toISOString() }
          report.executed++
          await this.writeLog(job, `done (${engine.id})`, effects.map((e) => `- ${e}`).join('\n') || '- no effects')
          done = true
          this.onJobDone?.(job.kind, index + 1, jobs.length)
        } catch (err) {
          if (this.signal?.aborted) { report.deferred++; return }
          if (err instanceof QuotaError || err instanceof AuthError || err instanceof OutageError) {
            const reason = err instanceof QuotaError ? 'quota' : err instanceof AuthError ? 'auth' : 'outage'
            const note = reason === 'quota' ? 'usage limit reached' : reason === 'auth' ? 'login expired' : 'provider not answering'
            if (err instanceof QuotaError && err.retryAfterMs !== undefined) report.quotaRetryAfterMs = err.retryAfterMs
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
              attempt--
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
          this.onJobDone?.(job.kind, i + 1, jobs.length)
          continue
        }
        if (halted || this.signal?.aborted || this.shouldStop?.()) {
          report.deferred++
          continue
        }
        await runOne(job, i)
      }
    }

    const width = Math.min(this.concurrency, Math.max(1, jobs.length))
    try { await Promise.all(Array.from({ length: width }, () => worker())) }
    finally { await this.saveJournal(journal) }
    if (report.executed > 0) await this.pruneLogs()
    return report
  }
}
