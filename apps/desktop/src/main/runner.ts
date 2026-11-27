import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineCwd, loadBots, LOOKUP_TOOLS, memberPersona, runComet, type Engine, type VaultPaths } from 'core'
import { answer, openWorld, worldTools, type AnswerTrace, type World } from './answer.js'
import type { ClaudeInputs } from './engine-claude.js'
import { SessionPool } from './engine-claude-session.js'
import { lookAsHelper } from './helper-lanes.js'
import { openStudies } from './study-offers.js'

const SETTLE_MS = 3_000
const settle = (): Promise<void> => new Promise(done => setTimeout(done, SETTLE_MS))

export interface SiteLog { visits: string[]; posts: string[] }
export interface CaseRun {
  answers: string[]
  site: SiteLog
  offers: { what: string; state: string }[]
  tasks: { schedule?: { hour?: number; days?: number[] } }[]
  steps: string[]
  files: string[]
  trace: AnswerTrace
}
export interface EvalCase {
  id: string
  ask(url: string): string
  as?: 'teammate' | 'helper'
  page?(path: string): { html: string; status?: number } | null
  aside?: { afterMs: number; text: string }
  before?: string[]
  files?: Record<string, string>
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

async function workFiles(paths: VaultPaths): Promise<string[]> {
  const entries = await readdir(paths.workspace, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => relative(paths.workspace, join(entry.parentPath, entry.name)).split(sep).join('/')).filter(path => !path.split('/').some(part => part.startsWith('.'))).sort()
}

async function seedFiles(paths: VaultPaths, files: Record<string, string>): Promise<Set<string>> {
  const own = new Set(await workFiles(paths))
  for (const [name, text] of Object.entries(files)) {
    const path = join(paths.workspace, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    own.delete(name)
  }
  return own
}

const MEMBER_NAME = 'Doyun'

async function handBack(world: World, as: 'teammate' | 'helper', message: string, signal: AbortSignal): Promise<AnswerTrace> {
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const trace: AnswerTrace = { message, steps: [], final: { text: '', ms: 0 }, end: 'done' }
  const onStep = (line: string) => { trace.steps.push({ line, ms: ms() }) }
  const deps = { engine: world.engine, workdir: engineCwd(world.paths) }
  try {
    const text = as === 'helper'
      ? await lookAsHelper({ ...deps, channel: `bot-${world.botId}`, guided: false, toolsFor: async () => worldTools(world, message, signal), onStep }, message, 0, signal)
      : (await runComet({ ...deps, tools: worldTools(world, message, signal).filter(tool => LOOKUP_TOOLS.has(tool.name)) }, message, {
        guided: false, role: 'deep', lookup: true, signal, onStep,
        persona: memberPersona({ id: 'member-1', parentId: null, depth: 1, role: MEMBER_NAME, brief: message, lookup: true, state: 'working', sessionKey: 'member-1', hiredAt: new Date().toISOString() }),
      })).answer
    trace.final = { text, ms: ms() }
  } catch (cause) {
    trace.final = { text: '', ms: ms() }
    trace.error = cause instanceof Error ? cause.message : String(cause)
  }
  if (signal.aborted) trace.end = 'stop'
  return trace
}

async function runCase(one: EvalCase, engine: Engine, out: string, deadlineMs: number, worlds: string[]): Promise<CaseRow> {
  const log: SiteLog = { visits: [], posts: [] }
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), deadlineMs)
  const steer: string[] = []
  let aside: NodeJS.Timeout | undefined
  const before: AnswerTrace[] = []
  let trace: AnswerTrace | undefined, checks: Record<string, boolean> = {}, failure: string | undefined
  let server: Server | undefined
  try {
    const served = await servePages(one, log)
    server = served.server
    const dir = await mkdtemp(join(out, `${one.id}-`))
    worlds.push(dir)
    const world = await openWorld(dir, engine)
    await engine.warmQuick?.(engineCwd(world.paths))
    await settle()
    const own = await seedFiles(world.paths, one.files ?? {})
    for (const ask of one.before ?? []) { before.push((await answer(world, ask, { signal: stop.signal })).trace); await settle() }
    const waiting = new Set<() => void>()
    const steered = (signal: AbortSignal): Promise<void> => new Promise(heard => { if (steer.length) return heard(); waiting.add(heard); signal.addEventListener('abort', () => heard(), { once: true }) })
    if (one.aside) aside = setTimeout(() => { steer.push(one.aside!.text); for (const wake of waiting) wake(); waiting.clear() }, one.aside.afterMs)
    trace = one.as ? await handBack(world, one.as, one.ask(served.url), stop.signal) : (await answer(world, one.ask(served.url), { signal: stop.signal, takeSteer: () => steer.splice(0), steered })).trace
    const tasks = (await loadBots(world.paths)).find(bot => bot.id === world.botId)?.tasks ?? []
    checks = one.grade({ answers: [trace.final.text], site: log, offers: await openStudies(world.paths, world.botId), tasks, steps: trace.steps.map(step => step.line), files: (await workFiles(world.paths)).filter(path => !own.has(path)), trace })
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause)
  } finally {
    clearTimeout(timer)
    clearTimeout(aside)
    server?.close()
  }
  const error = failure ?? [...before, trace].find(one => one?.error)?.error
  const end = trace?.end ?? 'error'
  await writeFile(join(out, `${one.id}.json`), JSON.stringify({ id: one.id, ...(before.length ? { before } : {}), ...trace, end, site: log, checks, ...(error ? { error } : {}) }, null, 2))
  return { id: one.id, pass: !error && end === 'done' && Object.values(checks).every(Boolean), checks, firstMs: trace?.first?.ms ?? null, finalMs: trace?.final.ms ?? 0, end, ...(error ? { error } : {}) }
}

export async function runCases(cases: EvalCase[], engine: Engine, options: { out: string; workers: number; deadlineMs: number }): Promise<CaseRow[]> {
  await mkdir(options.out, { recursive: true })
  const queue = [...cases], rows: CaseRow[] = [], worlds: string[] = []
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.workers, queue.length)) }, async () => {
    for (let one = queue.shift(); one; one = queue.shift()) {
      const row = await runCase(one, engine, options.out, options.deadlineMs, worlds).catch((cause): CaseRow => ({ id: one!.id, pass: false, checks: {}, firstMs: null, finalMs: 0, end: 'error', error: cause instanceof Error ? cause.message : String(cause) }))
      rows.push(row)
    }
  }))
  await Promise.all(worlds.map(dir => rm(dir, { recursive: true, force: true })))
  const order = cases.map(one => one.id)
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  await writeFile(join(options.out, 'summary.md'), summaryTable(rows))
  return rows
}

export function summaryTable(rows: CaseRow[]): string {
  const lines = rows.map(row => `| ${row.id} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.firstMs ?? '-'} | ${row.finalMs} | ${row.end} | ${[...Object.entries(row.checks).filter(([, ok]) => !ok).map(([name]) => name), row.error ?? ''].filter(Boolean).join(', ')} |`)
  return ['| case | result | first ms | final ms | end | failed |', '|---|---|---|---|---|---|', ...lines].join('\n') + '\n'
}
