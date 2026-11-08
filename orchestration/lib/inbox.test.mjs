import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'
import { addBrief, drain, pidPath, runnerPid } from './inbox.mjs'
import { loadLedger, saveLedger } from './ledger.mjs'

const schemas = fileURLToPath(new URL('../schemas', import.meta.url))
const temps = []

function tempCtx() {
  const root = mkdtempSync(join(tmpdir(), 'orch-inbox-'))
  temps.push(root)
  const orch = join(root, 'orchestration')
  mkdirSync(orch)
  symlinkSync(schemas, join(orch, 'schemas'))
  return { root, orch, logs: join(orch, 'logs'), dryRun: false, log: () => {} }
}

const brief = (id) => ({
  id, title: id, area: 'ts', difficulty: 'easy', allowedFiles: ['packages/core/src/a.ts'],
  criteria: [{ id: 'c1', cmd: 'true', expect: 'exit 0' }],
})

function writePid(ctx, pid) {
  mkdirSync(ctx.logs, { recursive: true })
  writeFileSync(pidPath(ctx), JSON.stringify({ pid }))
}

const ledgerFile = (ctx) => join(ctx.orch, 'ledger.json')
const inbox = (ctx) => readdirSync(join(ctx.logs, 'pending-adds'))

afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('add while a runner is active', () => {
  it('copies the brief and writes the id to the inbox without touching ledger.json', () => {
    const ctx = tempCtx()
    writePid(ctx, process.ppid)
    addBrief(ctx, brief('a'), '/elsewhere/a.json')
    expect(existsSync(ledgerFile(ctx))).toBe(false)
    expect(JSON.parse(readFileSync(join(ctx.orch, 'briefs/a.json'), 'utf8')).id).toBe('a')
    const files = inbox(ctx)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-a\.json$/)
    expect(JSON.parse(readFileSync(join(ctx.logs, 'pending-adds', files[0]), 'utf8'))).toEqual({ id: 'a' })
  })

  it('rejects an id already in the ledger', () => {
    const ctx = tempCtx()
    saveLedger(ctx.root, { batch: 'b', items: [{ id: 'a' }] })
    writePid(ctx, process.ppid)
    expect(() => addBrief(ctx, brief('a'), '/elsewhere/a.json')).toThrow(/already in the ledger/)
  })
})

describe('stale runner pid', () => {
  it('is not active and add writes the ledger directly', () => {
    const ctx = tempCtx()
    writePid(ctx, spawnSync(process.execPath, ['-e', '']).pid)
    expect(runnerPid(ctx)).toBeNull()
    addBrief(ctx, brief('a'), '/elsewhere/a.json')
    expect(loadLedger(ctx.root).items.map((i) => i.id)).toEqual(['a'])
    expect(existsSync(join(ctx.logs, 'pending-adds'))).toBe(false)
  })

  it('ignores a pid file naming the current process', () => {
    const ctx = tempCtx()
    writePid(ctx, process.pid)
    expect(runnerPid(ctx)).toBeNull()
  })
})

describe('drain', () => {
  it('appends inbox items in file-name order, skips known ids and empties the inbox', () => {
    const ctx = tempCtx()
    writePid(ctx, process.ppid)
    for (const id of ['c', 'a', 'b']) addBrief(ctx, brief(id), `/elsewhere/${id}.json`)
    const ledger = { batch: 'b', items: [{ id: 'a' }] }
    expect(drain(ctx, ledger)).toEqual(['c', 'b'])
    expect(ledger.items.map((i) => i.id)).toEqual(['a', 'c', 'b'])
    expect(ledger.items[1]).toMatchObject({ state: 'queued', bounces: 0, attempts: [], verdicts: [], scenarios: [] })
    expect(inbox(ctx)).toEqual([])
  })

  it('returns nothing when there is no inbox', () => {
    expect(drain(tempCtx(), { batch: 'b', items: [] })).toEqual([])
  })
})

describe('saveLedger', () => {
  it('replaces the file through a temp file and leaves no temp behind', () => {
    const ctx = tempCtx()
    saveLedger(ctx.root, { batch: 'one', items: [] })
    saveLedger(ctx.root, { batch: 'two', items: [] })
    expect(JSON.parse(readFileSync(ledgerFile(ctx), 'utf8')).batch).toBe('two')
    expect(readdirSync(ctx.orch).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
