import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveRunnerEngine } from '../scripts/runner-engine.mts'

const folder = mkdtempSync(join(tmpdir(), 'runner-engine-'))
const file = join(folder, 'engine')
const select = (value?: string, engine?: string) => {
  if (value !== undefined) writeFileSync(file, `${value}\n`)
  return resolveRunnerEngine({ ENGRAM_RUNNER_ENGINE_FILE: value === undefined ? join(folder, 'missing') : file, ENGRAM_RUNNER_ENGINE: engine })
}

describe('runner engine setting', () => {
  it('uses the valid environment value before the flag', () => {
    expect(select('codex', 'claude')).toBe('claude')
    expect(select('claude', 'codex')).toBe('codex')
  })

  it('uses the flag for empty or missing environment values', () => {
    expect(select('claude', '')).toBe('claude')
    expect(select('codex')).toBe('codex')
  })

  it('defaults to codex when the setting is missing or invalid', () => {
    expect(select()).toBe('codex')
    expect(select('unknown', 'other')).toBe('codex')
    expect(select('claude', 'other')).toBe('claude')
  })

  it('starts Codex without a Claude runtime', () => {
    const repo = join(import.meta.dirname, '../../..')
    const empty = join(folder, 'empty-cases.mts')
    writeFileSync(empty, 'export const CASES = []\n')
    const result = spawnSync(process.execPath, [join(repo, 'packages/core/node_modules/tsx/dist/cli.mjs'), join(repo, 'apps/desktop/scripts/runner.mts'), '--cases', empty], {
      cwd: repo,
      env: { ...process.env, ENGRAM_RUNNER_ENGINE: 'codex', ENGRAM_RUNNER_RUNTIME: '' },
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0/0 passed')
  })

  it('rejects Claude without its runtime before starting a case', () => {
    const repo = join(import.meta.dirname, '../../..')
    const result = spawnSync(process.execPath, [join(repo, 'packages/core/node_modules/tsx/dist/cli.mjs'), join(repo, 'apps/desktop/scripts/runner.mts')], {
      cwd: repo,
      env: { ...process.env, ENGRAM_RUNNER_ENGINE: 'claude', ENGRAM_RUNNER_RUNTIME: '' },
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ENGRAM_RUNNER_RUNTIME')
    expect(result.stderr).toContain('Claude runtime folder')
  })
})
