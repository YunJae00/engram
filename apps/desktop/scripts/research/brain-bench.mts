// The trap sites run by a whole comet - Claude or Codex working the page
// itself, no decision model - to see how often the brains fall into the same
// traps, and what the gate in their own loop changes. Graded by the last page
// the site served, never by what the comet says.
//
// Run from apps/desktop after a build:
//   node ../../packages/core/node_modules/tsx/dist/cli.mjs scripts/research/brain-bench.mts --brain=claude|codex [--gate=off|on] [--set=dev|test|final|all] [--repeat=N] [--parallel=N] [--only=a,b]
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type Server } from 'node:http'
import { appendFile, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type Page } from '@playwright/test'
import { initVault } from 'core'
import { FINAL, FINAL_TWO, HELD_OUT, TASKS, type GateTask, type SiteLog } from './gate-sites.mts'

const arg = (name: string) => process.argv.find(one => one.startsWith(`--${name}=`))?.slice(name.length + 3)
const brain = arg('brain') ?? 'claude'
const gate = arg('gate') ?? 'off'
const set = arg('set') ?? 'all'
const repeat = Number(arg('repeat') ?? 1)
const parallel = Number(arg('parallel') ?? 4)
const only = arg('only')?.split(',')
const tasks = [...TASKS, ...HELD_OUT, ...FINAL, ...FINAL_TWO].filter(one => (set === 'all' || one.set === set) && (!only || only.includes(one.id)))
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
await mkdir(join(repo, 'tmp', 'research'), { recursive: true })
const out = await mkdtemp(join(repo, 'tmp', 'research', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-brain-${brain}-${set}-${gate}-`))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function serve(task: GateTask, log: SiteLog): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (!path.includes('favicon')) log.visits.push(path)
    const page = task.page(path, log)
    if (page?.location) { res.writeHead(page.status ?? 302, { location: page.location }); res.end(); return }
    res.writeHead(page ? page.status ?? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page?.html ?? '<!doctype html><html><head><meta charset="utf-8"><title>찾을 수 없음</title></head><body><h1>페이지를 찾을 수 없습니다</h1><a href="/">홈으로</a></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, server }
}

async function runOne(win: Page, task: GateTask, round: number): Promise<any> {
  const log: SiteLog = { visits: [], served: new Map() }
  const { url, server } = await serve(task, log)
  const botId = (await win.evaluate(name => (window as any).engram.botCreate({ name }), `${task.id} ${round}`) as any).id
  const channel = `bot-${botId}`
  const started = Date.now()
  const message = `${url}${task.start} 에서 시작해서, ${task.goal}${task.text ? ` (검색어: ${task.text})` : ''} 그 페이지를 열어 둔 채로 끝내고, 어느 페이지인지만 짧게 알려줘.`
  await win.evaluate(({ botId, channel, message, brain }) => { void (window as any).engram.chatSend({ engineId: brain, message, history: [], attachments: [], botId, channel }) }, { botId, channel, message, brain })
  await wait(4000)
  let error = ''
  for (const deadline = Date.now() + 420_000; ; await wait(2000)) {
    const seen = await win.evaluate(c => (window as any).__bench[c]?.done.length ?? 0, channel)
    const active = await win.evaluate(() => (window as any).engram.chatActive()) as string[]
    if (seen > 0 && !active.includes(channel)) break
    if (Date.now() > deadline) { error = 'no answer within the time allowed'; break }
  }
  server.close()
  const steps = await win.evaluate(c => (window as any).__bench[c]?.steps ?? [], channel) as string[]
  const answer = (await win.evaluate(c => (window as any).__bench[c]?.done ?? [], channel) as string[]).join('\n')
  const finalPath = log.visits.at(-1) ?? ''
  const success = !error && task.reached(finalPath, log)
  return { brain, gate, task: task.id, trap: task.trap, set: task.set, round, success, finalPath, visits: log.visits, toolSteps: steps.filter(line => /^[a-z_]+: /.test(line) && !/^(said|you): /.test(line)).length, seconds: Math.round((Date.now() - started) / 1000), steps, answer: answer.slice(0, 600), error }
}

const root = join(out, 'profile')
const paths = await initVault(join(root, 'vault'), { git: false })
const userdata = join(root, 'userdata')
await mkdir(userdata, { recursive: true })
if (brain === 'claude') {
  const runtimes = join(process.env['APPDATA']!, 'desktop', 'runtimes', 'claude')
  const version = (await readdir(runtimes)).sort().at(-1)!
  await mkdir(join(userdata, 'runtimes', 'claude'), { recursive: true })
  await symlink(join(runtimes, version), join(userdata, 'runtimes', 'claude', version), 'junction')
}
await writeFile(join(userdata, 'settings.json'), JSON.stringify({ defaultEngine: brain, claudeModel: 'sonnet', computerUse: true, nativeTools: true, workMap: false, aiSelections: { filing: { engine: brain, ...(brain === 'claude' ? { model: 'sonnet' } : {}) } } }))
const env: Record<string, string | undefined> = { ...process.env, ENGRAM_USERDATA: userdata, ENGRAM_VAULT: paths.root, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_SESSION_WATCH: '0', ENGRAM_SEMANTIC: '0', ENGRAM_ENGINE: 'auto', ENGRAM_BRAIN_GATE: gate }
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[name]
const app = await electron.launch({ timeout: 120_000, args: [join(repo, 'apps/desktop/out/main/index.js'), '--no-sandbox'], env: env as Record<string, string> })
const child = app.process()
const rows: any[] = []
try {
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForFunction(() => !!(window as any).engram, { timeout: 120_000 })
  for (const deadline = Date.now() + 90_000; !await win.evaluate(() => (window as any).engram.vaultReady());) { if (Date.now() > deadline) throw new Error('vault'); await wait(500) }
  for (const deadline = Date.now() + 240_000; ; await wait(3000)) {
    const engines = await win.evaluate(() => (window as any).engram.enginesRefresh()) as any[]
    if (engines.some(one => one.id === brain && one.loggedIn)) break
    if (Date.now() > deadline) throw new Error(`${brain} is not signed in on this machine`)
  }
  await win.evaluate(() => {
    const w = window as any
    w.__bench = {}
    w.engram.onEvent((e: any) => {
      if (!e.channel) return
      const seen = w.__bench[e.channel] ??= { done: [], steps: [] }
      if (e.type === 'chat:done') seen.done.push(e.text)
      if (e.type === 'comet:step') seen.steps.push(e.line)
    })
  })
  const queue = Array.from({ length: repeat }, (_, round) => tasks.map(task => ({ task, round }))).flat()
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const row = await runOne(win, next.task, next.round)
      rows.push(row)
      await appendFile(join(out, 'runs.jsonl'), JSON.stringify(row) + '\n')
      console.log(`${row.success ? 'PASS' : 'FAIL'} ${row.task}#${row.round} ${row.toolSteps} steps ${row.seconds}s -> ${row.finalPath}${row.error ? ` (${row.error})` : ''}`)
    }
  }))
} finally {
  await Promise.race([app.close().catch(() => undefined), wait(20_000)])
  child.kill()
}
const summary = { brain, gate, set, runs: rows.length, success: rows.filter(row => row.success).length, toolSteps: rows.reduce((sum, row) => sum + row.toolSteps, 0), seconds: rows.reduce((sum, row) => sum + row.seconds, 0) }
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
console.log('out', out)
process.exit(0)
