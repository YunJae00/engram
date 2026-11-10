import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { MockEngine, type EngineCwd } from 'core'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngramEvent } from '../../src/shared/types.js'
import { closeTestApp } from '../navigation.js'
import { awaitSettled, frameP95, keyEventDurations, startProbe, stopProbe, svgCount, unpausedAnimations, watchStream } from './frame-probe.js'
import { droppedPct, judge, stats, summarize, type MetricId, type MetricResult } from './perf-rules.js'
import { MOCK_REPLY_CHARS, REPLY_SENTINEL, SEEDED, seedPerfVault, writeMockDir } from './seed-bots.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const MAIN = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const REPS = 5
const OPT_IN = process.env['ENGRAM_PERF'] === '1'
type Samples = Record<string, (number | null)[]>

// ---- results: one run file per playwright invocation, keyed on the runner pid so worker restarts reuse it
type Invocation = { runFile: string; baselinePath: string | null; writeBaseline: boolean; previousRun: string | null }

function outDir(): string {
  const env = process.env['ENGRAM_PERF_OUT']
  if (env && !isAbsolute(env)) throw new Error(`ENGRAM_PERF_OUT must be absolute: ${env}`)
  const dir = env || join(TMP, 'perf')
  mkdirSync(dir, { recursive: true })
  return dir
}

function findBaseline(dir: string): string | null {
  const local = join(dir, 'baseline.json')
  if (existsSync(local)) return local
  if (process.env['ENGRAM_PERF_OUT']) return null
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim()
    const main = resolve(common, '..', 'tmp', 'perf', 'baseline.json')
    return existsSync(main) ? main : null
  } catch { return null }
}

const RUN_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

function invocation(dir: string): Invocation {
  const marker = join(dir, `.invocation-${process.ppid}.json`)
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, 'utf8')) as Invocation
  const previous = readdirSync(dir).filter(f => RUN_FILE.test(f)).sort().at(-1) ?? null
  const baselinePath = findBaseline(dir)
  let runFile = ''
  for (;;) {
    runFile = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    try { writeFileSync(join(dir, runFile), '{}\n', { flag: 'wx' }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      execFileSync('sleep', ['0.002'])
    }
  }
  const inv: Invocation = { runFile, baselinePath, writeBaseline: baselinePath === null, previousRun: previous }
  writeFileSync(marker, JSON.stringify(inv), { flag: 'wx' })
  return inv
}

const readJson = (path: string): Record<string, MetricResult> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, MetricResult>

// shortcut: no cross-process lock; the config runs one worker, so merges never overlap.
function merge(path: string, id: MetricId, result: MetricResult): void {
  const current = existsSync(path) ? readJson(path) : {}
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify({ ...current, [id]: result }, null, 2)}\n`)
  renameSync(tmpPath, path)
}

function record(id: MetricId, samples: Samples, invariants: string[] = []): void {
  const dir = outDir(), inv = invocation(dir)
  const result = summarize(id, samples)
  const baseline = inv.writeBaseline || !inv.baselinePath ? undefined : readJson(inv.baselinePath)[id]
  const previous = inv.previousRun ? readJson(join(dir, inv.previousRun))[id] : undefined
  const verdict = judge(id, result, baseline, previous)
  if (verdict.referenceOnly) result.referenceOnly = true
  merge(join(dir, inv.runFile), id, result)
  if (inv.writeBaseline) merge(join(dir, 'baseline.json'), id, result)
  console.log(`[perf] ${id} ${JSON.stringify({ samples, result, baseline: baseline ?? null, ...verdict, invariants })}`)
  expect([...invariants, ...verdict.hard, ...(verdict.referenceOnly ? [] : verdict.soft)]).toEqual([])
}

// ---- app setup: one seeded master vault per worker, copied per launch
let master: string | null = null
const dirs: string[] = []
function vaultCopy(): string {
  mkdirSync(TMP, { recursive: true })
  if (!master) throw new Error('master vault not seeded')
  const copy = mkdtempSync(join(TMP, 'perf-vault-'))
  cpSync(master, copy, { recursive: true })
  dirs.push(copy)
  return copy
}

async function ensureMaster(): Promise<void> {
  if (master) return
  mkdirSync(TMP, { recursive: true })
  const dir = mkdtempSync(join(TMP, 'perf-seed-'))
  dirs.push(dir)
  await seedPerfVault(dir, Date.now())
  master = dir
}

type Launched = { app: ElectronApplication; page: Page }
async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const profile = mkdtempSync(join(TMP, 'perf-profile-'))
  dirs.push(profile)
  const app = await electron.launch({ args: [MAIN, '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vaultCopy(), ENGRAM_USERDATA: profile, ENGRAM_ENGINE: 'none',
    ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ...env,
  } })
  try { return { app, page: await ready(app) } } catch (error) { await closeTestApp(app); throw error }
}

async function ready(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId(`bot-${SEEDED.thread}`)).toBeAttached({ timeout: 60_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  return page
}

async function withApp(fn: (l: Launched) => Promise<void>, env?: Record<string, string>): Promise<void> {
  await ensureMaster()
  const launched = await launch(env)
  try { await fn(launched) } finally { await closeTestApp(launched.app) }
}

test.afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Clicks a sidebar row in the renderer and times until the new thread shows its loaded bubbles plus one frame.
const openBot = (page: Page, id: string) => page.evaluate(async (botId) => {
  const row = document.querySelector<HTMLElement>(`[data-testid="bot-${botId}"]`)
  if (!row) throw new Error(`no sidebar row for ${botId}`)
  const before = document.querySelector('.bots-chat')
  const started = performance.now()
  row.click()
  await new Promise<void>((done, fail) => {
    const check = () => {
      const chat = document.querySelector('.bots-chat')
      if (chat && chat !== before && chat.querySelectorAll('.bubble-msg').length >= 300) { done(); return }
      if (performance.now() - started > 20_000) { fail(new Error(`thread ${botId} did not render`)); return }
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
  await new Promise(r => requestAnimationFrame(r))
  return performance.now() - started
}, id)

const sampleMetrics = (app: ElectronApplication, seconds: number) => app.evaluate(async ({ app: electronApp, BrowserWindow }, secs) => {
  const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId()
  electronApp.getAppMetrics()
  const ticks: { total: number; renderer: number; memKB: number; rendererKB: number }[] = []
  for (let i = 0; i < secs; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const metrics = electronApp.getAppMetrics()
    const own = metrics.filter(m => m.pid === pid)
    ticks.push({
      total: metrics.reduce((s, m) => s + m.cpu.percentCPUUsage, 0), renderer: own.reduce((s, m) => s + m.cpu.percentCPUUsage, 0),
      memKB: metrics.reduce((s, m) => s + m.memory.workingSetSize, 0), rendererKB: own.reduce((s, m) => s + m.memory.workingSetSize, 0),
    })
  }
  return ticks
}, seconds)
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length

async function wheel(page: Page, selector: string, deltaY: number, ms: number): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const end = Date.now() + ms
  while (Date.now() < end) { await page.mouse.wheel(0, deltaY); await page.waitForTimeout(16) }
}

const emit = (app: ElectronApplication, event: EngramEvent) => app.evaluate(({ BrowserWindow }, payload) => {
  BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', payload)
}, event)

test('P1 cold launch to interactive composer', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await ensureMaster()
  const interactiveMs: number[] = []
  for (let r = 0; r < REPS; r++) {
    const profile = mkdtempSync(join(TMP, 'perf-profile-'))
    dirs.push(profile)
    const vault = vaultCopy()
    const started = performance.now()
    const app = await electron.launch({ args: [MAIN, '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile, ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    try {
      const page = await app.firstWindow({ timeout: 60_000 })
      await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
      const composer = page.locator('textarea:visible').first()
      await expect(composer).toBeEnabled({ timeout: 60_000 })
      await composer.focus()
      await expect(composer).toBeFocused()
      interactiveMs.push(performance.now() - started)
    } finally { await closeTestApp(app) }
  }
  record('P1', { interactiveMs })
})

test('P2 bot switch latency', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await withApp(async ({ page }) => {
    const sizes = await page.evaluate((ids) => Promise.all(ids.map(id => window.engram.botTranscript(id).then(t => t.length))), SEEDED.firstOpen)
    expect(sizes, 'first open renders the 400-turn transcript cap').toEqual(SEEDED.firstOpen.map(() => 400))
    for (const id of SEEDED.cached) await openBot(page, id)
    const cachedMs: number[] = [], firstOpenMs: number[] = []
    for (let r = 0; r < REPS; r++) {
      firstOpenMs.push(await openBot(page, SEEDED.firstOpen[r]!))
      const switches: number[] = []
      for (let i = 0; i < 20; i++) switches.push(await openBot(page, SEEDED.cached[i % SEEDED.cached.length]!))
      cachedMs.push(stats(switches).p95)
    }
    record('P2', { cachedMs, firstOpenMs })
  })
})

test('P3 bot list and sidebar render', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await withApp(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __perfBoot?: number[] }
      w.__perfBoot = []
      new PerformanceObserver(list => { for (const e of list.getEntries()) w.__perfBoot!.push(e.duration) }).observe({ type: 'longtask' })
    })
    const listMs: number[] = [], firstRenderLongtasks: number[] = [], scrollFrameMs: number[] = []
    for (let r = 0; r < REPS; r++) {
      listMs.push(await page.evaluate(async () => { const t = performance.now(); await window.engram.botsList(); return performance.now() - t }))
      await page.reload()
      await expect(page.locator('[data-testid^="bot-perf-bot-"]')).toHaveCount(SEEDED.all.length, { timeout: 60_000 })
      firstRenderLongtasks.push(await page.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        const boot = (window as Window & { __perfBoot?: number[] }).__perfBoot
        if (!boot) throw new Error('boot long task observer missing')
        return boot.length
      }))
      await startProbe(page)
      await wheel(page, '[data-testid="app-sidebar"]', 120, 1000)
      await wheel(page, '[data-testid="app-sidebar"]', -120, 1000)
      scrollFrameMs.push(frameP95((await stopProbe(page)).intervals))
    }
    record('P3', { listMs, firstRenderLongtasks, scrollFrameMs })
  })
})

test('P4 long thread scroll', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await withApp(async ({ page }) => {
    await openBot(page, SEEDED.thread)
    const s: Samples = { frameMs: [], droppedPct: [], longtasksOver100: [], anchorPx: [], heapMB: [] }
    for (let r = 0; r < REPS; r++) {
      await page.evaluate(() => { const t = document.querySelector('[data-testid="bots-thread"]')!; t.scrollTop = t.scrollHeight })
      await page.waitForTimeout(300)
      await startProbe(page)
      await wheel(page, '[data-testid="bots-thread"]', -120, 5000)
      const data = await stopProbe(page)
      s.frameMs!.push(frameP95(data.intervals))
      s.droppedPct!.push(droppedPct(data.intervals))
      s.longtasksOver100!.push(data.longtasks.filter(ms => ms > 100).length)
      s.heapMB!.push(await page.evaluate(() => (performance as Performance & { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576))
      s.anchorPx!.push(null)
    }
    console.log('[perf] P4 anchorPx is null: load-earlier (rd-load-earlier) does not exist yet, so there is no anchor to measure')
    record('P4', s)
  })
})

test('P5 typing input latency', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await withApp(async ({ page }) => {
    await openBot(page, SEEDED.thread)
    const composer = page.getByTestId('bots-input')
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(5).slice(0, 200)
    const s: Samples = { eventMs: [], maxEventMs: [], threadMutations: [] }
    for (let r = 0; r < REPS; r++) {
      await composer.fill('')
      await composer.focus()
      await startProbe(page, { mutationSelector: '[data-testid="bots-thread"]' })
      await page.keyboard.type(text, { delay: 30 })
      const data = await stopProbe(page)
      const keys = keyEventDurations(data)
      s.eventMs!.push(stats(keys).p95)
      s.maxEventMs!.push(Math.max(...keys, ...data.events.map(e => e.duration)))
      s.threadMutations!.push(data.mutations)
    }
    await composer.fill('')
    record('P5', s)
  })
})

test('P6 streaming reply render', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  mkdirSync(TMP, { recursive: true })
  const mockDir = mkdtempSync(join(TMP, 'perf-mock-'))
  dirs.push(mockDir)
  const reply = await writeMockDir(mockDir)
  const engine = await MockEngine.fromDir(mockDir)
  await withApp(async ({ app, page }) => {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as { __perfSends?: string[] }
      g.__perfSends = []
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', (_event, request: { channel: string }) => { g.__perfSends!.push(request.channel); return { channel: request.channel } })
    })
    const s: Samples = { frameMs: [], longtasksOver50: [], finalLagMs: [] }
    const invariants: string[] = []
    for (let r = 0; r < REPS; r++) {
      const botId = SEEDED.streaming[r]!, channel = `bot-${botId}`
      await openBot(page, botId)
      await watchStream(page, channel)
      await startProbe(page)
      await page.getByTestId('bots-input').fill(`Stream reply ${r}`)
      await page.getByTestId('bots-input').press('Enter')
      await expect.poll(() => app.evaluate((_e, ch) => (globalThis as { __perfSends?: string[] }).__perfSends!.includes(ch), channel)).toBe(true)
      for await (const event of engine.run({ prompt: 'JOB: default', workdir: mockDir as EngineCwd })) {
        if (event.type === 'token') await emit(app, { type: 'chat:token', channel, text: event.text })
        else if (event.type === 'result') await emit(app, { type: 'chat:done', channel, text: event.text })
        else throw new Error(`mock engine emitted ${JSON.stringify(event)}`)
      }
      const watch = await awaitSettled(page, REPLY_SENTINEL, 30_000)
      const data = await stopProbe(page)
      const joined = watch.tokens.map(t => t.text).join('')
      if (watch.tokens.length !== 4 || watch.tokens.some(t => !t.text)) invariants.push(`run ${r}: expected 4 nonempty chat:token events, got ${watch.tokens.length}`)
      if (joined !== reply || joined.length !== MOCK_REPLY_CHARS) invariants.push(`run ${r}: token text does not equal the ${MOCK_REPLY_CHARS}-char reply`)
      if (watch.doneText !== reply || watch.doneAt === null || watch.doneAt < watch.tokens.at(-1)!.at) invariants.push(`run ${r}: chat:done missing, early or wrong`)
      if (watch.settledAt === null) throw new Error(`run ${r}: final bubble never settled`)
      s.frameMs!.push(frameP95(data.intervals))
      s.longtasksOver50!.push(data.longtasks.filter(ms => ms > 50).length)
      s.finalLagMs!.push(watch.settledAt - watch.tokens.at(-1)!.at)
    }
    record('P6', s, invariants)
  }, { ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: mockDir })
})

test('P7 idle cpu and memory', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(480_000)
  await withApp(async ({ app }) => {
    await new Promise(r => setTimeout(r, 3000))
    const s: Samples = { cpuPct: [], memoryMB: [], rendererMB: [] }
    for (let r = 0; r < REPS; r++) {
      const ticks = await sampleMetrics(app, 60)
      s.cpuPct!.push(mean(ticks.map(t => t.total)))
      s.memoryMB!.push(Math.max(...ticks.map(t => t.memKB)) / 1024)
      s.rendererMB!.push(Math.max(...ticks.map(t => t.rendererKB)) / 1024)
    }
    record('P7', s)
  })
})

test('P8 working avatars animation cost', async () => {
  test.skip(!OPT_IN, 'Opt-in performance bench: set ENGRAM_PERF=1')
  test.setTimeout(300_000)
  await withApp(async ({ app, page }) => {
    const idle = mean((await sampleMetrics(app, 10)).map(t => t.renderer))
    for (const id of SEEDED.working) await emit(app, { type: 'comet:working', channel: `bot-${id}`, working: true })
    const working = () => page.evaluate((ids) => ids.filter(id => document.querySelector(`[data-testid="bot-${id}"] :is(.comet-activity-icon[data-state="running"], .bot-avatar[data-state="working"])`)).length, SEEDED.working)
    await expect.poll(working).toBe(SEEDED.working.length).catch(() => undefined)
    const invariants: string[] = []
    const s: Samples = { frameMs: [], svgElements: [], cpuOverIdlePp: [], unpausedAfterBlur: [] }
    for (let r = 0; r < REPS; r++) {
      const rows = await working()
      if (rows < SEEDED.working.length) invariants.push(`run ${r}: ${rows} of ${SEEDED.working.length} sidebar rows are working`)
      await startProbe(page)
      const ticks = await sampleMetrics(app, 5)
      const data = await stopProbe(page)
      s.frameMs!.push(frameP95(data.intervals))
      s.svgElements!.push(await svgCount(page))
      s.cpuOverIdlePp!.push(mean(ticks.map(t => t.renderer)) - idle)
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.blur() })
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 300))))
      s.unpausedAfterBlur!.push(await unpausedAnimations(page))
    }
    record('P8', s, invariants)
  })
})
