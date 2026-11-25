import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadBots, type Engine } from 'core'
import { answer, openWorld, type AnswerTrace } from './answer.js'
import type { ClaudeInputs } from './engine-claude.js'
import { SessionPool } from './engine-claude-session.js'
import { openStudies } from './study-offers.js'

export interface SiteLog { visits: string[]; posts: string[] }
export interface CaseRun {
  answers: string[]
  site: SiteLog
  offers: { what: string; state: string }[]
  tasks: { schedule?: { hour?: number; days?: number[] } }[]
}
export interface EvalCase {
  id: string
  ask(url: string): string
  page?(path: string): { html: string; status?: number } | null
  aside?: { afterMs: number; text: string }
  judged?: boolean
  desk?: [string, string, number][]
  grade(run: CaseRun): Record<string, boolean>
}

export interface CaseRow {
  id: string
  pass: boolean
  checks: Record<string, boolean>
  firstMs: number | null
  finalMs: number
  end: AnswerTrace['end'] | 'error'
  error?: string
}

export async function loadCases(file: string, only?: string[]): Promise<EvalCase[]> {
  const { CASES } = await import(pathToFileURL(file).href) as { CASES: EvalCase[] }
  const picked = only ? CASES.filter(one => only.includes(one.id)) : CASES
  const missing = only?.filter(id => !CASES.some(one => one.id === id)) ?? []
  if (missing.length) throw new Error(`no such case: ${missing.join(', ')}`)
  return picked
}

export async function servePages(one: EvalCase, log: SiteLog): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    log.visits.push(`${req.method} ${req.url}`)
    if (req.method === 'POST') { log.posts.push(req.url ?? ''); res.writeHead(303, { location: '/' }); res.end(); return }
    const where = new URL(req.url ?? '/', 'http://x')
    const page = one.page?.(`${where.pathname}${where.search}`)
    res.writeHead(page ? page.status ?? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page?.html ?? '<!doctype html><title>Not found</title><p>Not found</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server }
}

export function runtimeInputs(home: string, env: NodeJS.ProcessEnv = process.env): ClaudeInputs {
  const binary = join(home, 'runtime', process.platform === 'win32' ? 'claude.exe' : 'claude')
  const sdk = join(home, 'sdk', 'sdk.mjs')
  return {
    binary: () => existsSync(binary) && existsSync(sdk) ? binary : null,
    sdk: () => import(pathToFileURL(sdk).href),
    env: () => env,
    loadConnections: async () => {},
    hasConnection: () => false,
    clearConnection: async () => {},
    probeConnection: async () => ({ ok: false, status: 0 }),
    logTools: () => {},
    started: () => {},
    afterFirstSession: async () => {},
    sessions: new SessionPool(),
  }
}

async function runCase(one: EvalCase, engine: Engine, out: string, deadlineMs: number): Promise<CaseRow> {
  const log: SiteLog = { visits: [], posts: [] }
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), deadlineMs)
  const steer: string[] = []
  const aside = one.aside && setTimeout(() => steer.push(one.aside!.text), one.aside.afterMs)
  let trace: AnswerTrace | undefined, checks: Record<string, boolean> = {}, failure: string | undefined
  let server: Server | undefined, dir: string | undefined
  try {
    const served = await servePages(one, log)
    server = served.server
    dir = await mkdtemp(join(out, `${one.id}-`))
    const world = await openWorld(dir, engine)
    trace = await answer(world, one.ask(served.url), { signal: stop.signal, takeSteer: () => steer.splice(0) })
    const tasks = (await loadBots(world.paths)).find(bot => bot.id === world.botId)?.tasks ?? []
    checks = one.grade({ answers: [trace.final.text], site: log, offers: await openStudies(world.paths, world.botId), tasks })
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause)
  } finally {
    clearTimeout(timer)
    if (aside) clearTimeout(aside)
    server?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
  const error = failure ?? trace?.error
  const end = trace?.end ?? 'error'
  await writeFile(join(out, `${one.id}.json`), JSON.stringify({ id: one.id, ...trace, end, site: log, checks, ...(error ? { error } : {}) }, null, 2))
  return { id: one.id, pass: !error && end === 'done' && Object.values(checks).every(Boolean), checks, firstMs: trace?.first?.ms ?? null, finalMs: trace?.final.ms ?? 0, end, ...(error ? { error } : {}) }
}

export async function runCases(cases: EvalCase[], engine: Engine, options: { out: string; workers: number; deadlineMs: number }): Promise<CaseRow[]> {
  await mkdir(options.out, { recursive: true })
  const queue = [...cases], rows: CaseRow[] = []
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.workers, queue.length)) }, async () => {
    for (let one = queue.shift(); one; one = queue.shift()) {
      const row = await runCase(one, engine, options.out, options.deadlineMs).catch((cause): CaseRow => ({ id: one!.id, pass: false, checks: {}, firstMs: null, finalMs: 0, end: 'error', error: cause instanceof Error ? cause.message : String(cause) }))
      rows.push(row)
    }
  }))
  const order = cases.map(one => one.id)
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  await writeFile(join(options.out, 'summary.md'), summaryTable(rows))
  return rows
}

export function summaryTable(rows: CaseRow[]): string {
  const lines = rows.map(row => `| ${row.id} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.firstMs ?? '-'} | ${row.finalMs} | ${row.end} | ${[...Object.entries(row.checks).filter(([, ok]) => !ok).map(([name]) => name), row.error ?? ''].filter(Boolean).join(', ')} |`)
  return ['| case | result | first ms | final ms | end | failed |', '|---|---|---|---|---|---|', ...lines].join('\n') + '\n'
}
