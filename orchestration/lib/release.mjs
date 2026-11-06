import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fetchBranch, push } from './git.mjs'
import { transition } from './ledger.mjs'
import { bumpVersion } from './loop.mjs'
import { git, note, prepareNext, save, sh } from './runtime.mjs'

const PACKAGES = ['package.json', 'apps/desktop/package.json']

export function setVersion(text, version) {
  if (!/"version":\s*"[^"]*"/.test(text)) throw new Error('no version field')
  return text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
}

export async function release(ctx, ledger, kind) {
  if (ledger.integration?.state !== 'passed') throw new Error(`integration is ${ledger.integration?.state ?? 'not run'}; release needs a passed integration`)
  const { remote } = ctx.opts
  const { baseBranch, mainBranch } = ctx.roles
  const worktree = await prepareNext(ctx)
  const version = bumpVersion(JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')).version, kind)
  for (const file of PACKAGES) {
    const path = join(worktree, file)
    writeFileSync(path, setVersion(readFileSync(path, 'utf8'), version))
  }
  await git(worktree, 'add', ...PACKAGES)
  await git(worktree, 'commit', '-m', `bump version to ${version}`)
  await push(ctx.opts, worktree, baseBranch)
  note(ctx, 'batch', 'release', `bump ${kind}`, `version ${version} on ${baseBranch}`, await git(worktree, 'rev-parse', 'HEAD'))
  await fetchBranch(ctx.opts, mainBranch)
  const ancestor = await sh(worktree, 'git', ['merge-base', '--is-ancestor', `${remote}/${mainBranch}`, 'HEAD'])
  if (ancestor.code !== 0) throw new Error(`${mainBranch} is not an ancestor of ${baseBranch}; refusing to fast-forward`)
  await git(worktree, 'push', remote, `HEAD:refs/heads/${mainBranch}`)
  await git(worktree, 'tag', `v${version}`)
  await git(worktree, 'push', remote, `v${version}`)
  note(ctx, 'batch', 'release', `tag v${version}`, `${mainBranch} fast-forwarded to ${baseBranch}`, `v${version}`)
  for (const item of ledger.items.filter((i) => i.state === 'integrated')) {
    transition(item, 'released')
    note(ctx, item.id, 'release', 'released', `v${version}`)
  }
  save(ctx, ledger)
  return version
}

const SMOKE_JOB = /^smoke\b/

/** State of the Release workflow's desktop smoke from `gh run view --json jobs` output. */
export function smokeState(jobs) {
  const smoke = (jobs ?? []).filter((job) => SMOKE_JOB.test(job.name ?? ''))
  if (smoke.length === 0) return { state: 'missing', jobs: [] }
  const names = smoke.map((job) => `${job.name}: ${job.conclusion || job.status}`)
  if (smoke.some((job) => job.status !== 'completed')) return { state: 'pending', jobs: names }
  return { state: smoke.every((job) => job.conclusion === 'success') ? 'passed' : 'failed', jobs: names }
}

async function ghJson(ctx, args) {
  const { code, out } = await sh(ctx.root, 'gh', args)
  if (code !== 0) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

/** Waits for the desktop smoke job of the Release run for `tag` and returns its state. */
export async function awaitSmoke(ctx, tag, { timeoutMs = 90 * 60_000, pollMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = { state: 'missing', jobs: [] }
  let url = ''
  while (Date.now() < deadline) {
    const run = (await ghJson(ctx, ['run', 'list', '--workflow', 'release.yml', '--branch', tag, '--limit', '1', '--json', 'databaseId,url']))?.[0]
    if (run) {
      url = run.url
      last = smokeState((await ghJson(ctx, ['run', 'view', String(run.databaseId), '--json', 'jobs']))?.jobs)
      if (last.state === 'passed' || last.state === 'failed') break
    }
    await sleep(pollMs)
  }
  if (last.state === 'missing' || last.state === 'pending') last = { ...last, state: 'timeout' }
  note(ctx, 'batch', 'smoke', `smoke ${last.state}`, `${tag}: ${last.jobs.join('; ') || 'no smoke job found'}`, url)
  return { ...last, url }
}
