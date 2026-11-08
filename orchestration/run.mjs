#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { loadLedger } from './lib/ledger.mjs'
import { checkImplementation, designTick, promote, setDesign, startBriefed } from './lib/phase-implement.mjs'
import { batchIdle, integrate, integrationFinished, mergeVerified, resetIntegration, writeSummary } from './lib/phase-merge.mjs'
import { settle, verifyAttempt } from './lib/phase-verify.mjs'
import { addBrief, drain, pidPath, runnerPid } from './lib/inbox.mjs'
import { awaitSmoke, release } from './lib/release.mjs'
import { fetchBranch, fileAtRef } from './lib/git.mjs'
import { createContext, note, readJson, readJsonOrNull, save, schema, syncBaseBranch } from './lib/runtime.mjs'
import { validate } from './lib/validate.mjs'
import { integrationTier } from './lib/tier.mjs'
import { forEachItem } from './lib/loop.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = `usage:
  node orchestration/run.mjs add <brief.json>
  node orchestration/run.mjs run [--once] [--interval <s>] [--dry-run] [--reintegrate] [--full|--quick]
  node orchestration/run.mjs integrate [--full|--quick]
  node orchestration/run.mjs status
  node orchestration/run.mjs design <id> --pick claude|codex
  node orchestration/run.mjs release --bump patch|minor
  node orchestration/run.mjs smoke [--tag vX.Y.Z]`

const flag = (args, name) => args.includes(name)
const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

function add(ctx, file) {
  const brief = readJson(resolve(file))
  const errors = validate(schema(ctx, 'brief'), brief)
  if (errors.length) throw new Error(`brief invalid:\n${errors.join('\n')}`)
  addBrief(ctx, brief, resolve(file))
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
  if (!ctx.dryRun) {
    const added = drain(ctx, ledger)
    if (added.length) {
      save(ctx, ledger)
      for (const id of added) note(ctx, id, 'add', 'queued', 'drained from pending-adds')
    }
  }
  promote(ctx, ledger)
  if (!ctx.dryRun) {
    const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`)
    await forEachItem(ledger.items.filter((i) => i.state === 'designing'), (item) => designTick(ctx, ledger, item), log)
    await forEachItem(ledger.items.filter((i) => ['implementing', 'implemented', 'verifying'].includes(i.state)), async (item) => {
      for (const attempt of item.attempts.filter((a) => !a.outcome)) {
        if (!attempt.headSha) await checkImplementation(ctx, ledger, item, attempt)
        else await verifyAttempt(ctx, ledger, item, attempt)
      }
      await settle(ctx, ledger, item)
    }, log)
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
  const path = pidPath(ctx)
  const owner = runnerPid(ctx)
  if (owner) throw new Error(`run.mjs already running as pid ${owner}`)
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
    await syncBaseBranch(ctx)
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

// The desktop smoke runs in the Release workflow (smoke.yml); this reads its result.
async function smoke(ctx, tag) {
  if (!tag) {
    await fetchBranch(ctx.opts, ctx.roles.mainBranch)
    tag = `v${JSON.parse(await fileAtRef(ctx.opts, `${ctx.opts.remote}/${ctx.roles.mainBranch}`, 'package.json')).version}`
  }
  const result = await awaitSmoke(ctx, tag)
  ctx.log(`smoke ${result.state} for ${tag}${result.url ? ` ${result.url}` : ''}\n${result.jobs.join('\n')}`)
  if (result.state !== 'passed') process.exitCode = 1
}

async function main(argv) {
  const [command, ...args] = argv
  const ctx = createContext(ROOT, { dryRun: flag(args, '--dry-run') })
  ctx.integrationTier = integrationTier(ctx.roles, args)
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
  if (command === 'smoke') return smoke(ctx, option(args, '--tag'))
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
