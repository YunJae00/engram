import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCacheDir, restoreBuild, saveBuild } from './build-cache.mjs'
import { DESKTOP_BUILD, runCommands } from './evidence.mjs'

const temps = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-build-cache-')))
  temps.push(root)
  g(root, 'init', '-q')
  writeFileSync(join(root, '.gitignore'), 'apps/desktop/out/\napps/desktop/native-bin/\ntmp/\nwt*/\n')
  writeFileSync(join(root, 'src.ts'), 'export const a = 1\n')
  g(root, 'add', '.')
  g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return root
}
const worktree = (root, name) => {
  g(root, 'worktree', 'add', '-q', '--detach', join(root, name), 'HEAD')
  return join(root, name)
}
const writeBuild = (wt, text) => {
  for (const [rel, body] of [['apps/desktop/out/main/index.js', text], ['apps/desktop/native-bin/desktop/EngramDesktop', 'bin']]) {
    mkdirSync(dirname(join(wt, rel)), { recursive: true })
    writeFileSync(join(wt, rel), body)
  }
}

describe('desktop build cache', () => {
  it('keys by tree SHA under the main checkout tmp and restores into another worktree of the same tree', async () => {
    const root = repo()
    const a = worktree(root, 'wt-a')
    const b = worktree(root, 'wt-b')
    expect(await buildCacheDir(a)).toBe(join(root, 'tmp/desktop-build', g(root, 'rev-parse', 'HEAD^{tree}')))
    expect(await restoreBuild(b)).toBeNull()
    writeBuild(a, 'built')
    await saveBuild(a)
    expect(await restoreBuild(b)).toBe(await buildCacheDir(a))
    expect(readFileSync(join(b, 'apps/desktop/out/main/index.js'), 'utf8')).toBe('built')
    expect(existsSync(join(b, 'apps/desktop/native-bin/desktop/EngramDesktop'))).toBe(true)
  })

  it('has no key for a worktree with tracked edits or outside git', async () => {
    const root = repo()
    writeFileSync(join(root, 'src.ts'), 'export const a = 2\n')
    expect(await buildCacheDir(root)).toBeNull()
    const plain = mkdtempSync(join(tmpdir(), 'orch-build-plain-'))
    temps.push(plain)
    expect(await buildCacheDir(plain)).toBeNull()
  })

  it('misses on a different tree and keeps only the newest trees', async () => {
    const root = repo()
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'src.ts'), `export const a = ${i + 10}\n`)
      g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', `c${i}`)
      writeBuild(root, `b${i}`)
      await saveBuild(root)
    }
    expect(readdirSync(join(root, 'tmp/desktop-build'))).toHaveLength(3)
    g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'same tree')
    expect(await restoreBuild(root)).not.toBeNull()
    writeFileSync(join(root, 'src.ts'), 'export const a = 99\n')
    g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'new tree')
    expect(await restoreBuild(root)).toBeNull()
  })

  it('runCommands builds once on a miss and restores in the next worktree instead of building', async () => {
    const root = repo()
    const calls = []
    const run = async (cwd, cmd, args) => {
      calls.push(args[1])
      if (args[1] === DESKTOP_BUILD) writeBuild(cwd, 'fresh')
      return { code: 0, out: '' }
    }
    const commands = [{ id: 'boot', cmd: `${DESKTOP_BUILD} && node scripts/verify-cli.mjs boot` }]
    await runCommands(worktree(root, 'wt-a'), 'a', commands, 1000, run)
    const b = worktree(root, 'wt-b')
    await runCommands(b, 'b', commands, 1000, run)
    expect(calls).toEqual([DESKTOP_BUILD, 'node scripts/verify-cli.mjs boot', 'node scripts/verify-cli.mjs boot'])
    expect(readFileSync(join(b, 'apps/desktop/out/main/index.js'), 'utf8')).toBe('fresh')
  })
})
