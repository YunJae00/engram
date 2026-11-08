import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { isTerminal, loadLedger } from './ledger.mjs'
import { alive } from './procs.mjs'
import { briefPath, loadBrief, note, readJsonOrNull, save } from './runtime.mjs'

const inboxDir = (ctx) => join(ctx.logs, 'pending-adds')
export const pidPath = (ctx) => join(ctx.logs, 'run.pid')

export function itemFromBrief(brief) {
  return {
    id: brief.id, title: brief.title, area: brief.area, difficulty: brief.difficulty, state: 'queued', bounces: 0,
    allowedFiles: brief.allowedFiles, criteria: brief.criteria, scenarios: brief.scenarios ?? [], attempts: [], verdicts: [],
  }
}

// A pid file left by a crashed runner does not count as active.
export function runnerPid(ctx) {
  const pid = Number(readJsonOrNull(pidPath(ctx))?.pid)
  return pid && pid !== process.pid && alive(pid) ? pid : null
}

export function enqueue(ctx, id) {
  const dir = inboxDir(ctx)
  mkdirSync(dir, { recursive: true })
  // The monotonic clock orders adds that land in the same millisecond.
  const stamp = `${String(Date.now()).padStart(15, '0')}-${String(process.hrtime.bigint()).padStart(20, '0')}`
  const file = join(dir, `${stamp}-${id}.json`)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ id })}\n`)
  renameSync(temp, file)
  return file
}

// Appends queued briefs in file-name order and removes their inbox files; the caller saves the ledger.
export function drain(ctx, ledger) {
  let names
  try {
    names = readdirSync(inboxDir(ctx)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const added = []
  for (const name of names) {
    const file = join(inboxDir(ctx), name)
    const id = readJsonOrNull(file)?.id
    if (id && !ledger.items.some((i) => i.id === id)) {
      ledger.items.push(itemFromBrief(loadBrief(ctx, id)))
      added.push(id)
    }
    rmSync(file, { force: true })
  }
  return added
}

// Expects a validated brief; source is the absolute path it was read from.
export function addBrief(ctx, brief, source) {
  const target = briefPath(ctx, brief.id)
  const copy = () => {
    mkdirSync(join(ctx.orch, 'briefs'), { recursive: true })
    if (source !== target) writeFileSync(target, `${JSON.stringify(brief, null, 2)}\n`)
  }
  // A running runner owns ledger.json; hand it the id through the inbox instead.
  if (runnerPid(ctx)) {
    if (readJsonOrNull(join(ctx.orch, 'ledger.json'))?.items.some((i) => i.id === brief.id)) throw new Error(`${brief.id} is already in the ledger`)
    copy()
    enqueue(ctx, brief.id)
    note(ctx, brief.id, 'add', 'pending', `brief ${basename(source)} queued for the running runner`, target)
    return
  }
  let ledger = loadLedger(ctx.root)
  const finished = ledger.items.length > 0 && ledger.items.every((i) => isTerminal(i.state))
  if (finished && ['passed', 'failed'].includes(ledger.integration?.state)) {
    renameSync(join(ctx.orch, 'ledger.json'), join(ctx.orch, `ledger-${ledger.batch}.json`))
    ledger = loadLedger(ctx.root)
  }
  if (ledger.items.some((i) => i.id === brief.id)) throw new Error(`${brief.id} is already in the ledger`)
  copy()
  ledger.items.push(itemFromBrief(brief))
  save(ctx, ledger)
  note(ctx, brief.id, 'add', 'queued', `brief ${basename(source)}`, target)
}
