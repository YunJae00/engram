/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type Page } from '@playwright/test'
import { initVault } from 'core'
import { CASES } from './eval-quick-cases.mts'
import { servePages, type CaseRun, type EvalCase, type SiteLog } from '../src/main/runner.js'

const arg = (name: string) => process.argv.find(one => one.startsWith(`--${name}=`))?.slice(name.length + 3)
const brains = (arg('brain') ?? 'both') === 'both' ? ['claude', 'codex'] : [arg('brain')!]
const repeat = Number(arg('repeat') ?? 1)
const parallel = Number(arg('parallel') ?? 4)
const only = arg('only')?.split(',')
const cases = CASES.filter(one => !only || only.includes(one.id))
const repo = fileURLToPath(new URL('../../../', import.meta.url))
await mkdir(join(repo, 'tmp', 'eval'), { recursive: true })
const out = await mkdtemp(join(repo, 'tmp', 'eval', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-`))
const codeRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function seedDesk(paths: { workspace: string }): Promise<void> {
  const lines = cases.flatMap(one => one.desk ?? [])
  if (!lines.length) return
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const room = (Date.now() - 60_000 - midnight.getTime()) / 60_000
  const wanted = lines.reduce((sum, [, , minutes]) => sum + minutes, 0)
  const scale = Math.min(1, room / wanted)
  let at = Date.now() - 60_000 - wanted * scale * 60_000
  const files = new Map<string, string[]>()
  for (const [app, title, minutes] of lines) {
    const end = at + minutes * scale * 60_000
    const day = new Date(at).toISOString().slice(0, 10)
    files.set(day, [...(files.get(day) ?? []), JSON.stringify({ app, title, start: new Date(at).toISOString(), end: new Date(end).toISOString() })])
    at = end
  }
  await mkdir(join(paths.workspace, '.engram', 'activity'), { recursive: true })
  for (const [day, rows] of files) await writeFile(join(paths.workspace, '.engram', 'activity', `${day}.jsonl`), rows.join('\n') + '\n')
}

async function turnEnds(win: Page, channel: string, answersBefore: number, deadline: number): Promise<void> {
  for (; Date.now() < deadline; await wait(2000)) {
    const seen = await win.evaluate(c => (window as any).__eval[c]?.done.length ?? 0, channel)
    const active = await win.evaluate(() => (window as any).engram.chatActive()) as string[]
    if (seen > answersBefore && !active.includes(channel)) return
  }
  throw new Error('no answer within the time allowed')
}

async function runCase(win: Page, brain: string, one: EvalCase, round: number): Promise<any> {
  const log: SiteLog = { visits: [], posts: [] }
  const { url, server } = await servePages(one, log)
  const started = Date.now()
  let error = ''
  let laterSent = false
  const botId = (await win.evaluate(name => (window as any).engram.botCreate({ name }), `${one.id} ${round}`) as any).id
  const channel = `bot-${botId}`
  const send = (message: string) => win.evaluate(({ botId, channel, message, brain }) => { void (window as any).engram.chatSend({ engineId: brain, message, history: [], attachments: [], botId, channel }) }, { botId, channel, message, brain })
  try {
    await send(one.ask(url))
    if (one.aside) {
      await wait(one.aside.afterMs)
      const said = await win.evaluate(({ channel, text }) => (window as any).engram.chatSay(channel, text), { channel, text: one.aside.text }) as any
      if (said?.ok && said.action === 'later' && said.instruction) { await turnEnds(win, channel, 0, started + 480_000); await send(said.instruction); laterSent = true }
    }
    await turnEnds(win, channel, 0, started + 480_000)
    if (one.judged) await wait(35_000)
    const returned = (await win.evaluate(c => (window as any).__eval[c]?.returned ?? [], channel) as string[]).length
    if (returned) await turnEnds(win, channel, returned + (laterSent ? 1 : 0), Date.now() + 360_000)
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  const answers = await win.evaluate(c => (window as any).__eval[c]?.done ?? [], channel) as string[]
  const offers = await win.evaluate(id => (window as any).engram.studyList(id), botId) as any[]
  const tasks = ((await win.evaluate(() => (window as any).engram.botsList())) as any[]).find(bot => bot.id === botId)?.tasks ?? []
  server.close()
  const run: CaseRun = { answers, site: log, offers, tasks, steps: [], files: [] }
  const checks = one.grade(run)
  return { codeRevision, dirty, model: brain === 'claude' ? 'sonnet' : 'runtime-default', effort: 'runtime-default', brain, id: one.id, round, seconds: Math.round((Date.now() - started) / 1000), pass: !error && Object.values(checks).every(Boolean), checks, error, answer: answers.join('\n---\n').slice(0, 1500), visits: log.visits.length, steps: await win.evaluate(c => (window as any).__eval[c]?.steps ?? 0, channel) }
}

async function runBrain(brain: string): Promise<any[]> {
  const root = join(out, brain)
  const paths = await initVault(join(root, 'vault'), { git: false })
  await seedDesk(paths)
  const userdata = join(root, 'userdata')
  await mkdir(userdata, { recursive: true })
  if (brain === 'claude') {
    const runtimes = join(process.env['APPDATA']!, 'desktop', 'runtimes', 'claude')
    const version = (await readdir(runtimes)).sort().at(-1)!
    await mkdir(join(userdata, 'runtimes', 'claude'), { recursive: true })
    await symlink(join(runtimes, version), join(userdata, 'runtimes', 'claude', version), 'junction')
  }
  await writeFile(join(userdata, 'settings.json'), JSON.stringify({ defaultEngine: brain, claudeModel: 'sonnet', computerUse: true, nativeTools: true, workMap: false, aiSelections: { filing: { engine: brain, ...(brain === 'claude' ? { model: 'sonnet' } : {}) } } }))
  const env: Record<string, string | undefined> = { ...process.env, ENGRAM_USERDATA: userdata, ENGRAM_VAULT: paths.root, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_SESSION_WATCH: '0', ENGRAM_SEMANTIC: '0', ENGRAM_ENGINE: 'auto' }
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
      w.__eval = {}
      w.engram.onEvent((e: any) => {
        if (!e.channel) return
        const seen = w.__eval[e.channel] ??= { done: [], returned: [], steps: 0 }
        if (e.type === 'chat:done') seen.done.push(e.text)
        if (e.type === 'comet:step') seen.steps += 1
        if (e.type === 'chat:steer-returned') seen.returned.push(...e.texts)
      })
    })
    const queue = Array.from({ length: repeat }, (_, round) => cases.map(one => ({ one, round }))).flat()
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const row = await runCase(win, brain, next.one, next.round)
        rows.push(row)
        console.log(`${brain} ${row.pass ? 'PASS' : 'FAIL'} ${row.id}#${row.round} ${row.seconds}s ${row.pass ? '' : JSON.stringify(row.checks)}${row.error ? ` (${row.error})` : ''}`)
      }
    }))
  } catch (cause) {
    console.log(`${brain}: ${cause instanceof Error ? cause.message : String(cause)}`)
    rows.push({ brain, id: '(setup)', pass: false, error: cause instanceof Error ? cause.message : String(cause) })
  } finally {
    await Promise.race([app.close().catch(() => undefined), wait(20_000)])
    child.kill()
  }
  return rows
}

const rows: any[] = []
for (const brain of brains) rows.push(...await runBrain(brain))
await writeFile(join(out, 'report.json'), JSON.stringify(rows, null, 2))
const summary = brains.map(brain => {
  const mine = rows.filter(row => row.brain === brain && row.id !== '(setup)')
  const byCase = Object.fromEntries(cases.map(one => { const runs = mine.filter(row => row.id === one.id); return [one.id, `${runs.filter(row => row.pass).length}/${runs.length}`] }))
  return { at: new Date().toISOString(), brain, passed: mine.filter(row => row.pass).length, runs: mine.length, byCase }
})
for (const line of summary) await appendFile(join(repo, 'tmp', 'eval', 'history.jsonl'), JSON.stringify(line) + '\n')
for (const line of summary) console.log(`${line.brain}: ${line.passed}/${line.runs} passed  ${Object.entries(line.byCase).map(([id, score]) => `${id} ${score}`).join(' | ')}`)
console.log('report', join(out, 'report.json'))
process.exit(rows.length === brains.length * cases.length * repeat && rows.every(row => row.pass) ? 0 : 1)
