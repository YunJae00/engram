// The gate experiments: page_do run alone with the real browser and the
// real decision model against the trap sites, every step traced, graded by
// where each run ended. One app, runs side by side, each task on its own port.
//
// Run from apps/desktop after a build, with a decision model connected in the app:
//   node ../../packages/core/node_modules/tsx/dist/cli.mjs scripts/research/gate-bench.mts [--gate=off|on|always] [--repeat=N] [--parallel=N] [--only=a,b]
// Writes tmp/research/<run>/runs.jsonl and summary.json.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type Server } from 'node:http'
import { appendFile, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { initVault } from 'core'
import { FINAL, FINAL_TWO, HELD_OUT, TASKS, type GateTask, type SiteLog } from './gate-sites.mts'

const arg = (name: string) => process.argv.find(one => one.startsWith(`--${name}=`))?.slice(name.length + 3)
const gate = arg('gate') ?? 'off'
const margin = arg('margin') ? Number(arg('margin')) : undefined
// Parts of the gate switched on or off for measuring: --with=explore, --without=replay
const withParts = arg('with')?.split(',') ?? []
const without = arg('without')?.split(',') ?? []
const variant = [...withParts.map(part => `with-${part}`), ...without.map(part => `without-${part}`)].join('-')
const repeat = Number(arg('repeat') ?? 3)
const parallel = Number(arg('parallel') ?? 4)
const only = arg('only')?.split(',')
const set = arg('set') ?? 'dev'
const tasks = [...TASKS, ...HELD_OUT, ...FINAL, ...FINAL_TWO].filter(one => (set === 'all' || one.set === set) && (!only || only.includes(one.id)))
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
await mkdir(join(repo, 'tmp', 'research'), { recursive: true })
const out = await mkdtemp(join(repo, 'tmp', 'research', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${set}-${gate}${variant ? `-${variant}` : ''}${margin ? `-m${margin}` : ''}-`))

async function serve(task: GateTask, log: SiteLog): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    log.visits.push(path)
    const page = task.page(path, log)
    if (page?.location) { res.writeHead(page.status ?? 302, { location: page.location }); res.end(); return }
    res.writeHead(page ? page.status ?? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page?.html ?? '<!doctype html><html><head><meta charset="utf-8"><title>찾을 수 없음</title></head><body><h1>페이지를 찾을 수 없습니다</h1><a href="/">홈으로</a></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, server }
}

async function runOne(app: ElectronApplication, task: GateTask, round: number): Promise<any> {
  const log: SiteLog = { visits: [], served: new Map() }
  const { url, server } = await serve(task, log)
  const lane = `research-${task.id}-${round}`
  let outcome: any = null, error = ''
  try {
    outcome = await app.evaluate(async (_electron, input) => (globalThis as any).__engramResearch.pageDo(input), { url: `${url}${task.start}`, goal: task.goal, ...(task.text ? { text: task.text } : {}), maxSteps: 12, lane, gate, ...(margin ? { margin } : {}), ...(withParts.includes('explore') ? { explore: true } : {}), ...(without.includes('replay') ? { replay: false } : {}) })
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  server.close()
  let result: any = {}
  try { result = JSON.parse(outcome?.result ?? '{}') } catch { result = { status: 'unreadable', note: outcome?.result } }
  const finalPath = (() => { try { const at = new URL(result.url); return at.pathname + at.search } catch { return '' } })()
  const success = !error && task.reached(finalPath, log)
  return { task: task.id, trap: task.trap, gate: variant ? `${gate}-${variant}` : gate, margin, round, success, status: result.status ?? 'error', note: result.note, finalPath, decisions: outcome?.trace?.length ?? 0, ms: outcome?.ms ?? 0, visits: log.visits, trace: outcome?.trace ?? [], error }
}

const root = join(out, 'profile')
const paths = await initVault(join(root, 'vault'), { git: false })
const userdata = join(root, 'userdata')
await mkdir(userdata, { recursive: true })
// The decision model the person connected, with the key that unseals it on this machine.
const installed = join(process.env['APPDATA']!, 'desktop')
for (const name of ['Local State', 'connections.json']) await copyFile(join(installed, name), join(userdata, name))
await writeFile(join(userdata, 'settings.json'), JSON.stringify({ computerUse: true, workMap: false }))
const env: Record<string, string | undefined> = { ...process.env, ENGRAM_USERDATA: userdata, ENGRAM_VAULT: paths.root, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_SESSION_WATCH: '0', ENGRAM_SEMANTIC: '0', ENGRAM_ENGINE: 'none', ENGRAM_RESEARCH: '1' }
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[name]
const app = await electron.launch({ timeout: 120_000, args: [join(repo, 'apps/desktop/out/main/index.js'), '--no-sandbox'], env: env as Record<string, string> })
const child = app.process()
const rows: any[] = []
try {
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForFunction(() => !!(window as any).engram, { timeout: 120_000 })
  for (const deadline = Date.now() + 90_000; !await win.evaluate(() => (window as any).engram.vaultReady());) { if (Date.now() > deadline) throw new Error('vault'); await new Promise(r => setTimeout(r, 500)) }
  const queue = Array.from({ length: repeat }, (_, round) => tasks.map(task => ({ task, round }))).flat()
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const row = await runOne(app, next.task, next.round)
      rows.push(row)
      await appendFile(join(out, 'runs.jsonl'), JSON.stringify(row) + '\n')
      console.log(`${row.success ? 'PASS' : 'FAIL'} ${row.task}#${row.round} ${row.status} ${row.decisions} decisions ${Math.round(row.ms / 1000)}s -> ${row.finalPath}${row.error ? ` (${row.error})` : ''}`)
    }
  }))
} finally {
  await Promise.race([app.close().catch(() => undefined), new Promise(r => setTimeout(r, 20_000))])
  child.kill()
}
const summary = tasks.map(task => {
  const mine = rows.filter(row => row.task === task.id)
  const mean = (pick: (row: any) => number) => mine.length ? Math.round(mine.reduce((sum, row) => sum + pick(row), 0) / mine.length * 10) / 10 : 0
  return { task: task.id, success: `${mine.filter(row => row.success).length}/${mine.length}`, decisions: mean(row => row.decisions), seconds: mean(row => row.ms / 1000) }
})
const all = { set, gate, margin, runs: rows.length, success: rows.filter(row => row.success).length, decisions: rows.reduce((sum, row) => sum + row.decisions, 0), seconds: Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / 1000), tasks: summary }
await writeFile(join(out, 'summary.json'), JSON.stringify(all, null, 2))
console.log(JSON.stringify(all))
console.log('out', out)
process.exit(0)
