import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
