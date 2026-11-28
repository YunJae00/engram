import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveRunnerEngine(env: NodeJS.ProcessEnv = process.env): 'claude' | 'codex' {
  if (env['ENGRAM_RUNNER_ENGINE'] === 'claude' || env['ENGRAM_RUNNER_ENGINE'] === 'codex') return env['ENGRAM_RUNNER_ENGINE']
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const root = statSync(join(repo, '.git')).isFile() ? resolve(repo, '../../../..') : repo
  const file = env['ENGRAM_RUNNER_ENGINE_FILE'] || resolve(env['ORCH_ROOT'] || root, 'tmp/factory/RUNNER_ENGINE')
  let value = ''
  try { value = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] || '' } catch { return 'codex' }
  return value === 'claude' || value === 'codex' ? value : 'codex'
}
