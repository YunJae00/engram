// The whole e2e suite in two passes: specs that never touch the real screen run
// three at a time, the ones that drive windows, the pointer or live services run
// one at a time afterwards. Every spec still runs; only the schedule changes.
//
//   node scripts/e2e-all.mjs            both passes
//   node scripts/e2e-all.mjs --screen   the serial pass only
//   node scripts/e2e-all.mjs --quiet    the parallel pass only
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url))
// Specs that take the foreground, move the pointer, capture the screen or reach a live account.
const SCREEN = new Set(['computer-control.spec.ts', 'appearance.spec.ts', 'live-view.spec.ts', 'native-browser.spec.ts', 'page-hands.spec.ts', 'browser-preview.spec.ts',
  'onboarding.spec.ts', 'routines.spec.ts', 'work-evidence.spec.ts', 'evidence-live.spec.ts', 'developers-live.spec.ts', 'account-usage-live.spec.ts', 'app-reset.spec.ts'])
const WORKERS = process.env['E2E_WORKERS'] ?? '3'

const specs = readdirSync(join(desktop, 'e2e')).filter(name => name.endsWith('.spec.ts')).sort()
const screen = specs.filter(name => SCREEN.has(name))
const quiet = specs.filter(name => !SCREEN.has(name))
if (process.argv.includes('--list')) { console.log(JSON.stringify({ quiet, screen })); process.exit(0) }
const only = process.argv.includes('--screen') ? 'screen' : process.argv.includes('--quiet') ? 'quiet' : 'both'

function run(label, list, workers) {
  if (!list.length) return 0
  const started = Date.now()
  console.log(`\n== ${label}: ${list.length} spec(s), ${workers} worker(s)`)
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', `--workers=${workers}`, ...list.map(name => `e2e/${name}`)], { cwd: desktop, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  console.log(`== ${label} finished in ${Math.round((Date.now() - started) / 60000)} min`)
  return result.status ?? 1
}

let status = 0
if (only !== 'screen') status = run('quiet specs', quiet, WORKERS) || status
if (only !== 'quiet') status = run('screen specs', screen, 1) || status
process.exit(status)
