import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const all = readdirSync(new URL('../../../apps/desktop/e2e/', import.meta.url)).filter(name => name.endsWith('.spec.ts')).sort()
const run = (script: string, ...args: string[]) => execFileSync(process.execPath, [`scripts/${script}.mjs`, '--list', ...args], { cwd: root, encoding: 'utf8' })

describe('e2e schedules', () => {
  it('keeps every spec exactly once across the fast runner passes', () => {
    const { quiet, screen } = JSON.parse(run('e2e-all')) as { quiet: string[]; screen: string[] }
    expect([...quiet, ...screen].sort()).toEqual(all)
    expect(screen).toContain('computer-control.spec.ts')
    expect(screen).toContain('app-reset.spec.ts')
    expect(screen).toContain('onboarding.spec.ts')
    expect(screen).toContain('routines.spec.ts')
  })

  it('selects the affected area and explicit specs', () => {
    const result = run('e2e-affected', 'apps/desktop/src/main/desktop-quiet.ts')
    expect(result).toContain('computer-control.spec.ts')
    expect(result).toContain('work-evidence.spec.ts')
    expect(result).not.toContain('app-reset.spec.ts')
    expect(run('e2e-affected', 'apps/desktop/e2e/queued-messages.spec.ts')).toContain('queued-messages.spec.ts')
  })

  it('falls back to the entire suite for unmapped code and dependencies', () => {
    for (const path of ['packages/core/src/new-area.ts', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      const result = run('e2e-affected', path)
      for (const spec of all) expect(result).toContain(spec)
    }
  })

  it('does not expand the suite for unit tests or verification scripts', () => {
    for (const path of ['apps/desktop/test/quiet-result-state.test.ts', 'scripts/e2e-affected.mjs']) {
      expect(run('e2e-affected', path)).toContain('1 spec(s): shell.spec.ts')
    }
  })

  it('ignores version-only manifests, but not dependency changes or an unknown baseline', () => {
    mkdirSync(join(root, 'tmp'), { recursive: true })
    const fixture = mkdtempSync(join(root, 'tmp/e2e-manifest-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim()
    const select = () => execFileSync(process.execPath, ['scripts/e2e-affected.mjs', '--list', 'package.json'], { cwd: fixture, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      mkdirSync(join(fixture, 'scripts'), { recursive: true })
      mkdirSync(join(fixture, 'apps/desktop/e2e'), { recursive: true })
      copyFileSync(join(root, 'scripts/e2e-affected.mjs'), join(fixture, 'scripts/e2e-affected.mjs'))
      for (const spec of all) writeFileSync(join(fixture, 'apps/desktop/e2e', spec), '')
      writeFileSync(join(fixture, 'package.json'), '{"version":"1","dependencies":{"a":"1"}}')
      git('init', '--quiet')
      git('add', 'package.json')
      git('update-ref', 'refs/remotes/origin/main', git('write-tree'))
      writeFileSync(join(fixture, 'package.json'), '{"version":"2","dependencies":{"a":"1"}}')
      expect(select()).toContain('1 spec(s): shell.spec.ts')
      writeFileSync(join(fixture, 'package.json'), '{"version":"2","dependencies":{"a":"2"}}')
      const dependenciesChanged = select()
      for (const spec of all) expect(dependenciesChanged).toContain(spec)
      git('update-ref', '-d', 'refs/remotes/origin/main')
      const baselineUnknown = select()
      for (const spec of all) expect(baselineUnknown).toContain(spec)
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })
})
