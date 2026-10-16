import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
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
  })

  it('selects the affected area and explicit specs', () => {
    const result = run('e2e-affected', 'apps/desktop/src/main/desktop-quiet.ts')
    expect(result).toContain('computer-control.spec.ts')
    expect(result).toContain('work-evidence.spec.ts')
    expect(result).not.toContain('app-reset.spec.ts')
    expect(run('e2e-affected', 'apps/desktop/e2e/queued-messages.spec.ts')).toContain('queued-messages.spec.ts')
  })

  it('falls back to the entire suite for unmapped code and dependencies', () => {
    for (const path of ['packages/core/src/new-area.ts', 'package.json', 'pnpm-lock.yaml']) {
      const result = run('e2e-affected', path)
      for (const spec of all) expect(result).toContain(spec)
    }
  })
})
