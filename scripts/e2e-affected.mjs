// The e2e specs a change can reach, from the paths it touched. A heuristic by
// design: the release run still covers everything; this run answers "did I
// break the area I was working in" in minutes instead of hours.
//
//   node scripts/e2e-affected.mjs            specs for the files changed since origin/main (plus the working tree)
//   node scripts/e2e-affected.mjs --list     print the chosen specs without running them
//   node scripts/e2e-affected.mjs a.ts b.ts  specs for the given paths
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const e2e = join(root, 'apps/desktop/e2e')
const SMOKE = ['shell.spec.ts']
// Path fragments → the specs that exercise that area. Order does not matter; a path may hit several rows.
const AREAS = [
  [/native\/desktop\/|desktop-quiet|desktop-agent|desktop-control|desktop-host|desktop-access|desktop-sequence|desktop-overlay|application-work|desktop-tools|desktop-quiet-tools/, ['computer-control.spec.ts', 'work-evidence.spec.ts', 'developers.spec.ts']],
  [/engine-|brain-connections|KeyConnection|account-profiles|codex-|claude-runtime|engine-signin|EngineSettings|ModelPicker|ai-selection/, ['engine-settings.spec.ts', 'key-connections.spec.ts', 'ai-card-layout.spec.ts', 'ai-recovery.spec.ts', 'connection-state.spec.ts', 'developers.spec.ts']],
  [/agent-session|agent-loop|agent-prompt|task-runner|task-result|result-check|chat|Composer|Conversation|conversation|queued|interim|evidence/, ['chat.spec.ts', 'chat-attachments.spec.ts', 'chat-save.spec.ts', 'queued-messages.spec.ts', 'quick-comet.spec.ts', 'conversation-polish.spec.ts', 'conversation-sidebar.spec.ts', 'work-evidence.spec.ts']],
  [/renderer\/src\/App\.tsx|\.css$|Shell|layout|Sidebar|activity|Tour|onboarding|Onboarding|appearance|update/, ['layout.spec.ts', 'shell.spec.ts', 'appearance.spec.ts', 'activity-ui.spec.ts', 'onboarding.spec.ts']],
  [/interview|work-map|WorkInterview|cosmos|filing/, ['work-interview.spec.ts', 'work-interview-feedback.spec.ts', 'work-interview-preparation.spec.ts']],
  [/routine|learning/, ['routines.spec.ts', 'routine-learning.spec.ts']],
  [/browser|page-|web-|live-view|mirror|preview/, ['page-hands.spec.ts', 'browser-preview.spec.ts', 'native-browser.spec.ts', 'live-view.spec.ts']],
  [/developer|workspace|artifact/, ['developers.spec.ts', 'tasks.spec.ts', 'artifact.spec.ts', 'workspace-delete.spec.ts']],
  [/index\.ts$|ipc\.ts$|vault|settings\.ts|reset|quit|boot/, ['shell.spec.ts', 'app-reset.spec.ts', 'background-workers.spec.ts', 'chat.spec.ts']],
]

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const given = args.filter(arg => !arg.startsWith('--'))

function changedPaths() {
  const out = (cmd) => execFileSync('git', cmd, { cwd: root, encoding: 'utf8' })
  const lines = [...out(['diff', '--name-only', 'origin/main...HEAD']).split('\n'), ...out(['diff', '--name-only', 'HEAD']).split('\n'), ...out(['ls-files', '--others', '--exclude-standard']).split('\n')]
  return [...new Set(lines.map(line => line.trim()).filter(Boolean))]
}

const paths = given.length ? given : changedPaths()
const chosen = new Set(SMOKE)
for (const path of paths) {
  const normalized = path.replace(/\\/g, '/')
  if (/\.(md|txt|png|ico|svg)$/.test(normalized)) continue
  if (/^apps\/desktop\/e2e\//.test(normalized) && normalized.endsWith('.spec.ts')) { chosen.add(normalized.split('/').pop()); continue }
  let matched = false
  for (const [pattern, specs] of AREAS) if (pattern.test(normalized)) { matched = true; for (const spec of specs) chosen.add(spec) }
  if (!matched) for (const spec of readdirSync(e2e).filter(name => name.endsWith('.spec.ts'))) chosen.add(spec)
}
const specs = [...chosen].sort()
for (const spec of specs) if (!existsSync(join(e2e, spec))) throw new Error(`Mapped spec does not exist: ${spec}`)
console.log(`${paths.length} changed path(s) → ${specs.length} spec(s): ${specs.join(' ')}`)
if (listOnly) process.exit(0)
if (specs.length === 0) process.exit(0)
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...specs.map(spec => `e2e/${spec}`)], { cwd: join(root, 'apps/desktop'), stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exit(result.status ?? 1)
