import { mkdir, mkdtemp } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initLog } from '../src/main/flog.js'
import { ClaudeEngine, closeVoices } from '../src/main/engine-claude.js'
import { resolveRunnerEngine } from './runner-engine.mts'
import { runnerUserData } from './runner-electron.mts'
import { loadCases, runCases, runtimeInputs, summaryTable } from '../src/main/runner.js'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`)
  return process.argv.find(one => one.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (at >= 0 ? process.argv[at + 1] : undefined)
}
const selected = resolveRunnerEngine()
const home = process.env['ENGRAM_RUNNER_RUNTIME']
if (selected === 'claude' && !home) { console.error('Set ENGRAM_RUNNER_RUNTIME to a Claude runtime folder (the one holding runtime/ and sdk/).'); process.exit(2) }
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const file = arg('cases') ?? fileURLToPath(new URL('./eval-quick-cases.mts', import.meta.url))
const cases = await loadCases(file, arg('only')?.split(','))
await mkdir(join(repo, 'tmp', 'runner'), { recursive: true })
const out = await mkdtemp(join(repo, 'tmp', 'runner', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-`))
initLog(out)
const inputs = selected === 'claude' ? runtimeInputs(home!) : undefined
if (selected === 'codex') registerHooks({ resolve(specifier, context, nextResolve) { return specifier === 'electron' ? { url: new URL('./runner-electron.mts', import.meta.url).href, shortCircuit: true } : nextResolve(specifier, context) } })
const codex = selected === 'codex' ? await import('../src/main/engine-codex.js') : undefined
if (codex) { const { initializeAccountProfiles } = await import('../src/main/account-profiles.js'); await initializeAccountProfiles(runnerUserData) }
const engine = inputs ? new ClaudeEngine(inputs, process.env['ENGRAM_RUNNER_PROFILE'] ?? 'system') : new codex!.CodexEngine(process.env['ENGRAM_RUNNER_PROFILE'] || undefined)
const started = Date.now()
const rows = await runCases(cases, engine, { out, workers: Number(arg('workers') ?? 2), deadlineMs: Number(arg('deadline') ?? 480) * 1000 })
if (inputs) { inputs.sessions.closeAll(); closeVoices(inputs) }
else codex!.closeCodexSessions()
console.log(summaryTable(rows))
console.log(`${rows.filter(row => row.pass).length}/${rows.length} passed in ${Math.round((Date.now() - started) / 1000)}s, traces in ${out}`)
process.exit(rows.every(row => row.pass) ? 0 : 1)
