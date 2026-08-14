import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Track D — dependency & supply-chain audit lock.
// These assertions pin the safe transitive bumps applied during the audit so a
// future dependency change cannot silently regress them back to a vulnerable
// version. If a bump here needs to move, update the minimums deliberately.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

/** Compare dotted numeric versions; returns a<b => -1, a==b => 0, a>b => 1. */
function cmp(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10))
  const pb = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** All resolved versions of `name` that appear as top-level keys in the lockfile. */
function resolvedVersions(lock: string, name: string): string[] {
  const re = new RegExp(`^  ${name.replace(/[/@+.]/g, '\\$&')}@([0-9][^:(]*)`, 'gm')
  const out: string[] = []
  for (const m of lock.matchAll(re)) {
    const v = m[1]
    if (v) out.push(v.trim())
  }
  return out
}

describe('supply-chain: safe transitive bumps stay applied', () => {
  it('root package.json pins the audit overrides', () => {
    const pkg = JSON.parse(readText('package.json')) as {
      pnpm?: { overrides?: Record<string, string> }
    }
    const overrides = pkg.pnpm?.overrides ?? {}
    expect(overrides['brace-expansion@1']).toBe('1.1.16')
    expect(overrides['brace-expansion@2']).toBe('2.1.2')
    expect(overrides['fast-uri']).toBe('^3.1.4')
  })

  it('lockfile carries no vulnerable brace-expansion / fast-uri', () => {
    const lock = readText('pnpm-lock.yaml')

    // GHSA: brace-expansion ReDoS — patched >=1.1.16 (v1) and >=2.1.2 (v2).
    for (const v of resolvedVersions(lock, 'brace-expansion')) {
      if (v.startsWith('1.')) expect(cmp(v, '1.1.16')).toBeGreaterThanOrEqual(0)
      if (v.startsWith('2.')) expect(cmp(v, '2.1.2')).toBeGreaterThanOrEqual(0)
    }

    // GHSA: fast-uri host confusion — patched >=3.1.4.
    for (const v of resolvedVersions(lock, 'fast-uri')) {
      expect(cmp(v, '3.1.4')).toBeGreaterThanOrEqual(0)
    }

    // Sanity: the parser actually found the packages (guards a silent no-op).
    expect(resolvedVersions(lock, 'fast-uri').length).toBeGreaterThan(0)
    expect(resolvedVersions(lock, 'brace-expansion').length).toBeGreaterThan(0)
  })
})
