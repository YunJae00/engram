#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { ensureBranch, fetchBranch } from './lib/git.mjs'
import { isTerminal, loadLedger } from './lib/ledger.mjs'
import { checkImplementation, designTick, promote, setDesign, startBriefed } from './lib/phase-implement.mjs'
import { batchIdle, integrate, integrationFinished, mergeVerified, resetIntegration, writeSummary } from './lib/phase-merge.mjs'
import { settle, verifyAttempt } from './lib/phase-verify.mjs'
import { alive } from './lib/procs.mjs'
import { release } from './lib/release.mjs'
import { briefPath, createContext, note, readJson, readJsonOrNull, save, schema } from './lib/runtime.mjs'
import { validate } from './lib/validate.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = `usage:
  node orchestration/run.mjs add <brief.json>
  node orchestration/run.mjs run [--once] [--interval <s>] [--dry-run] [--reintegrate]
  node orchestration/run.mjs integrate
  node orchestration/run.mjs status
  node orchestration/run.mjs design <id> --pick claude|codex
  node orchestration/run.mjs release --bump patch|minor`

const flag = (args, name) => args.includes(name)
const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

function add(ctx, file) {
  const brief = readJson(resolve(file))
  const errors = validate(schema(ctx, 'brief'), brief)
  if (errors.length) throw new Error(`brief invalid:\n${errors.join('\n')}`)
  let ledger = loadLedger(ROOT)
  const finished = ledger.items.length > 0 && ledger.items.every((i) => isTerminal(i.state))
  if (finished && ['passed', 'failed'].includes(ledger.integration?.state)) {
    renameSync(join(ctx.orch, 'ledger.json'), join(ctx.orch, `ledger-${ledger.batch}.json`))
    ledger = loadLedger(ROOT)
  }
  if (ledger.items.some((i) => i.id === brief.id)) throw new Error(`${brief.id} is already in the ledger`)
  const target = briefPath(ctx, brief.id)
  mkdirSync(join(ctx.orch, 'briefs'), { recursive: true })
  if (resolve(file) !== target) writeFileSync(target, `${JSON.stringify(brief, null, 2)}\n`)
  ledger.items.push({
    id: brief.id, title: brief.title, area: brief.area, difficulty: brief.difficulty, state: 'queued', bounces: 0,
    allowedFiles: brief.allowedFiles, criteria: brief.criteria, scenarios: brief.scenarios ?? [], attempts: [], verdicts: [],
  })
  save(ctx, ledger)
  note(ctx, brief.id, 'add', 'queued', `brief ${basename(file)}`, target)
}

function status(ledger) {
  const rows = [['item', 'state', 'bounces', 'attempt', 'implementer', 'verifier', 'deadline', 'outcome']]
  for (const item of ledger.items) {
    const a = item.attempts.at(-1)
    rows.push([item.id, item.state, item.bounces, a?.n ?? '-', a?.implementer ?? '-', a?.verifier ?? '-', a?.deadlineAt ?? '-', a?.outcome ?? item.reason ?? '-'])
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)))
  const lines = rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c])).join('  ').trimEnd())
  const integration = ledger.integration ? `\nintegration: ${ledger.integration.state}` : ''
  return `batch ${ledger.batch}\n${lines.join('\n')}${integration}`
}

async function tick(ctx) {
  const ledger = ctx.dryRun ? (readJsonOrNull(join(ctx.orch, 'ledger.json')) ?? { batch: 'dry-run', items: [] }) : loadLedger(ROOT)
  promote(ctx, ledger)
  if (!ctx.dryRun) {
    for (const item of ledger.items.filter((i) => i.state === 'designing')) await designTick(ctx, ledger, item)
    for (const item of ledger.items.filter((i) => ['implementing', 'implemented', 'verifying'].includes(i.state))) {
      for (const attempt of item.attempts.filter((a) => !a.outcome)) {
        if (!attempt.headSha) await checkImplementation(ctx, ledger, item, attempt)
        else await verifyAttempt(ctx, ledger, item, attempt)
      }
      await settle(ctx, ledger, item)
    }
    await mergeVerified(ctx, ledger)
  }
  await startBriefed(ctx, ledger)
  if (ctx.dryRun || !batchIdle(ledger)) return false
  if (integrationFinished(ledger)) return true
  await integrate(ctx, ledger)
  writeSummary(ctx, ledger)
  return true
}

function lock(ctx) {
  const path = join(ctx.logs, 'run.pid')
  const owner = Number(readJsonOrNull(path)?.pid)
  if (owner && owner !== process.pid && alive(owner)) throw new Error(`run.mjs already running as pid ${owner}`)
  mkdirSync(ctx.logs, { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: process.pid }))
  return () => rmSync(path, { force: true })
}

async function run(ctx, args) {
  const interval = Number(option(args, '--interval') ?? 30) * 1000
  if (ctx.dryRun) {
    ctx.log('dry-run: one tick, nothing launched, ledger not written')
    await tick(ctx)
    return
  }
  const unlock = lock(ctx)
  try {
    await fetchBranch(ctx.opts, ctx.roles.mainBranch)
    if (await ensureBranch(ctx.opts, ctx.roles.baseBranch, `${ctx.opts.remote}/${ctx.roles.mainBranch}`)) {
      note(ctx, 'batch', 'run', `create ${ctx.roles.baseBranch}`, `from ${ctx.roles.mainBranch}`)
    }
    if (flag(args, '--reintegrate')) {
      const ledger = loadLedger(ROOT)
      if (ledger.integration?.state === 'failed') {
        resetIntegration(ledger)
        save(ctx, ledger)
        note(ctx, 'batch', 'integrate', 'pending', 'resumed with --reintegrate')
      }
    }
    for (;;) {
      let done = false
      try {
        done = await tick(ctx)
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} tick failed: ${error.stack ?? error}\n`)
      }
      if (done || flag(args, '--once')) break
      await sleep(interval)
    }
  } finally {
    unlock()
  }
}

async function integrateOnce(ctx) {
  const unlock = lock(ctx)
  try {
    const ledger = loadLedger(ROOT)
    resetIntegration(ledger)
    save(ctx, ledger)
    note(ctx, 'batch', 'integrate', 'pending', 'rerun by the Conductor')
    await integrate(ctx, ledger)
    ctx.log(`integration ${ledger.integration.state}; summary ${writeSummary(ctx, ledger)}`)
  } finally {
    unlock()
  }
}

async function main(argv) {
  const [command, ...args] = argv
  const ctx = createContext(ROOT, { dryRun: flag(args, '--dry-run') })
  if (command === 'add' && args[0]) return add(ctx, args[0])
  if (command === 'status') return ctx.log(existsSync(join(ctx.orch, 'ledger.json')) ? status(loadLedger(ROOT)) : 'ledger empty')
  if (command === 'run') return run(ctx, args)
  if (command === 'design' && args[0] && ['claude', 'codex'].includes(option(args, '--pick'))) {
    const ledger = loadLedger(ROOT)
    const item = ledger.items.find((i) => i.id === args[0])
    if (!item) throw new Error(`${args[0]} is not in the ledger`)
    return setDesign(ctx, ledger, item, option(args, '--pick'), 'picked by the Conductor')
  }
  if (command === 'integrate') return integrateOnce(ctx)
  if (command === 'release' && ['patch', 'minor'].includes(option(args, '--bump'))) {
    return ctx.log(`released v${await release(ctx, loadLedger(ROOT), option(args, '--bump'))}`)
  }
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
