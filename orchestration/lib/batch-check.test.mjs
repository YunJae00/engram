import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedCheck } from './batch.mjs'
import { loadJobs } from './runtime.mjs'

let root
let ctx
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

// A branch off `next` that adds one file; returns its tip.
function branch(name, file, body) {
  git('checkout', '-q', '-b', name, 'next')
  writeFileSync(join(root, file), body)
  git('add', file)
  git('commit', '-qm', `add ${file}`)
  git('checkout', '-q', 'next')
  return git('rev-parse', name)
}

const attempt = (id, headSha) => ({ n: 1, branch: `orch/${id}-1`, headSha, logPath: '/logs/batch-a-x2.log' })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-batch-check-'))
  git('init', '-q', '-b', 'next')
  git('config', 'user.name', 'orch test')
  git('config', 'user.email', 'orch@test.invalid')
  // The check passes only on a tree holding both members' files.
  const check = 'node -e "process.exit([\'a.txt\',\'b.txt\'].every((f)=>require(\'fs\').existsSync(f))?0:1)"'
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'check:quick': check } }))
  git('add', '.')
  git('commit', '-qm', 'base')
  ctx = { root, opts: { root }, base: 'next', logs: join(root, 'orchestration/logs'), worktrees: join(root, 'tmp/w'), dryRun: false }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('sharedCheck', () => {
  it('runs check:quick once on base plus every implemented member and reuses it', async () => {
    const a = attempt('a', branch('a', 'a.txt', 'a'))
    const b = attempt('b', branch('b', 'b.txt', 'b'))
    const ledger = { items: [{ attempts: [a] }, { attempts: [b] }] }
    const shared = await sharedCheck(ctx, ledger, a)
    expect(shared).toMatchObject({ exit: 0, shas: [a.headSha, b.headSha] })
    expect(readFileSync(shared.logPath, 'utf8')).toContain('exit 0')
    const firstLog = loadJobs(ctx)['batch-a-x2-check']
    expect(await sharedCheck(ctx, ledger, b)).toEqual(firstLog)
  }, 30_000)

  it('returns null (each item checks alone) when the members conflict or there is no sibling', async () => {
    const a = attempt('a', branch('a', 'a.txt', 'one'))
    const b = attempt('b', branch('b', 'a.txt', 'two'))
    expect(await sharedCheck(ctx, { items: [{ attempts: [a] }, { attempts: [b] }] }, a)).toBeNull()
    expect(loadJobs(ctx)['batch-a-x2-check'].reason).toMatch(/merge/)
    expect(await sharedCheck(ctx, { items: [{ attempts: [a] }] }, a)).toBeNull()
  }, 30_000)
})
