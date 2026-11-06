#!/usr/bin/env node
// node scripts/verify-cli.mjs <scenario> [--build] [--root <dir>] | --list
// --root picks the checkout whose build, node_modules and tmp/verify-cli are used; scenarios come from this repo.
// Launches the built desktop app on a fresh vault, runs one scenario, prints one JSON line.
// A scenario may export `launch`: `env` adds variables to the app's environment, `seed(core, paths)` fills the vault before launch.
import { createWriteStream, existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from './verify-cli-args.mjs'

const SCENARIO_DIR = fileURLToPath(new URL('./verify-scenarios/', import.meta.url))
let opts
try {
  opts = parseArgs(process.argv.slice(2), fileURLToPath(new URL('../', import.meta.url)), process.cwd())
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(2)
}
const REPO = opts.root
const DESKTOP = join(REPO, 'apps/desktop')
const MAIN_ENTRY = join(DESKTOP, 'out/main/index.js')
const OUT_DIR = join(REPO, 'tmp/verify-cli')
const BUDGET_MS = 90_000

let launchedChild
let pendingLaunch
const tempDirs = []
const scenarios = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort()

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}

async function launch(name, log) {
  const req = createRequire(join(DESKTOP, 'package.json'))
  const { register } = await import(pathToFileURL(createRequire(join(REPO, 'packages/core/package.json')).resolve('tsx/esm/api')).href)
  register()
  const { _electron, expect } = (await import(pathToFileURL(req.resolve('@playwright/test')).href)).default
  const core = await import(pathToFileURL(join(REPO, 'packages/core/src/index.ts')).href)
  const nav = await import(pathToFileURL(join(DESKTOP, 'e2e/navigation.ts')).href)
  const scenario = await import(pathToFileURL(join(SCENARIO_DIR, `${name}.mjs`)).href)
  const launchWith = scenario.launch ?? {}

  const root = await mkdtemp(join(OUT_DIR, `${name}-vault-`))
  const userData = await mkdtemp(join(OUT_DIR, `${name}-userdata-`))
  tempDirs.push(root, userData)
  const paths = await core.initVault(root, { git: false })
  await core.createNote(paths, { id: 'n-hello-0001', body: '# Hello note\n\nThe very first note.' })
  await core.createNote(paths, { id: 'n-argo-0001', body: '# Argo redesign\n\nThe umbrella decision.' })
  await core.createNote(paths, { id: 'n-argo-0002', body: '# Argo palette\n\nColor decisions.', derived_from: ['n-argo-0001'] })
  if (launchWith.seed) await launchWith.seed(core, paths)

  pendingLaunch = _electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_USERDATA: userData,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
      ...(launchWith.env ?? {}),
    },
  })
  const app = await pendingLaunch
  launchedChild = app.process()
  app.process().stdout?.pipe(log, { end: false })
  app.process().stderr?.pipe(log, { end: false })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (err) => log.write(`[renderer pageerror] ${err.stack ?? err}\n`))
    page.on('console', (msg) => log.write(`[renderer ${msg.type()}] ${msg.text()}\n`))
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
    return await scenario.run(page, { app, paths, expect, openActivity: nav.openActivity, log })
  } finally {
    await nav.closeTestApp(app)
    await rm(root, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
}

// A launch still pending at the budget is awaited so its Electron process can be killed.
async function settledChild() {
  if (!pendingLaunch) return null
  let timer
  const app = await Promise.race([
    pendingLaunch.catch(() => null),
    new Promise((done) => { timer = setTimeout(() => done(null), 30_000) }),
  ])
  clearTimeout(timer)
  return app?.process() ?? null
}

if (opts.list) {
  process.stdout.write(`${scenarios.join('\n')}\n`)
  process.exit(0)
}
const { name } = opts
const started = Date.now()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = relative(REPO, join(OUT_DIR, `${name || 'none'}-${stamp}.log`))
const fail = (evidence) => emit({ scenario: name, ok: false, ms: Date.now() - started, evidence, logPath })

if (!scenarios.includes(name)) fail(`unknown scenario "${name}"; known: ${scenarios.join(', ')}`)
await mkdir(OUT_DIR, { recursive: true })
const log = createWriteStream(join(REPO, logPath))
if (opts.build) {
  const built = spawnSync('pnpm', ['--filter', 'desktop', 'build'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  log.write(`${built.stdout ?? ''}${built.stderr ?? ''}`)
  if (built.status !== 0) fail(`pnpm --filter desktop build failed (status ${built.status ?? built.error?.message})`)
}
if (!existsSync(MAIN_ENTRY)) fail('apps/desktop/out/main/index.js missing; run with --build')

let timer
try {
  const result = await Promise.race([
    launch(name, log),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`scenario exceeded ${BUDGET_MS / 1000}s budget`)), BUDGET_MS) }),
  ])
  clearTimeout(timer)
  log.write(`[verify-cli] ${JSON.stringify(result)}\n`)
  await new Promise((done) => log.end(done))
  emit({ scenario: name, ok: Boolean(result.ok), ms: Date.now() - started, evidence: result.evidence, logPath })
} catch (error) {
  // Budget overrun leaves the scenario mid-flight; kill only the Electron process this run spawned.
  const child = launchedChild ?? (await settledChild())
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  log.write(`[verify-cli] ${error.stack ?? error}\n`)
  await new Promise((done) => log.end(done))
  fail(String(error.message ?? error).split('\n')[0].slice(0, 300))
}
