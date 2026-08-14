// A brand-new user, as literally as this machine allows: empty userData, empty
// vault, and the app pointed at a HOME with no ~/.claude at all. Reading code
// finds the failures you thought of; booting finds the ones you did not.
//
// Everything is written under a throwaway root, so the real profile, the real
// vault and the real ~/.claude/CLAUDE.md are untouched.
import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'coldstart-'))
const home = join(root, 'home')
const vault = join(root, 'vault')
const userData = join(root, 'userData')
await mkdir(home, { recursive: true })
await mkdir(userData, { recursive: true })

const errors: string[] = []
const t0 = Date.now()

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    // A fresh account: no ~/.claude, no config, nothing.
    HOME: home,
    USERPROFILE: home,
    ENGRAM_VAULT: vault,
    ENGRAM_USERDATA: userData,
    // The interesting case is "no engine on the machine".
    ENGRAM_ENGINE: 'none',
  },
})

app.on('window', (w) => {
  w.on('pageerror', (e) => errors.push(`renderer: ${e.message}`))
  w.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`)
  })
})
app.process().stderr?.on('data', (d: Buffer) => {
  const line = d.toString().trim()
  if (line) errors.push(`main: ${line.slice(0, 300)}`)
})

const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(`renderer: ${e.message}`))

const step = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn()
    console.log(`  ok    ${label}  (+${Date.now() - t0}ms)`)
  } catch (err) {
    console.log(`  FAIL  ${label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
}

console.log('cold start, empty everything:')
await step('window appears', () => page.waitForLoadState('domcontentloaded'))
await step('shell renders', () => page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 }))
await step('vault opens (opening state clears)', () =>
  page.getByTestId('vault-opening').waitFor({ state: 'detached', timeout: 60_000 }),
)
await step('no-engine banner explains itself', () =>
  page.getByTestId('connect-banner').waitFor({ state: 'visible', timeout: 60_000 }),
)
await step('capture works with no engine', async () => {
  await page.getByTestId('remember-button').click()
  await page.getByTestId('chat-input').fill('첫 캡처 — 엔진 없이')
  await page.keyboard.press('Enter')
  await page.getByTestId('chat-kept').last().waitFor({ state: 'visible', timeout: 30_000 })
})
await step('Today opens', async () => {
  // Escape deliberately does NOT close the composer (it would discard what you
  // typed) — the close button is the way out, same as the e2e does it.
  await page.getByTestId('chat-close').click()
  await page.getByTestId('today-button').click()
  await page.getByTestId('today-sheet').waitFor({ state: 'visible', timeout: 20_000 })
  await page.keyboard.press('Escape')
})
await step('Settings opens', async () => {
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('settings-view').waitFor({ state: 'visible', timeout: 20_000 })
  await page.keyboard.press('Escape')
})

// Let the background work (detection, context sync, session watch, auto-tidy
// boot pass) actually run before judging it.
await page.waitForTimeout(20_000)

console.log('\nwhat the app wrote outside the vault:')
const claudeDir = join(home, '.claude')
const listed = await readdir(claudeDir).catch(() => null)
console.log('  ~/.claude:', listed ? listed.join(', ') : '(not created)')
const claudeMd = await readFile(join(claudeDir, 'CLAUDE.md'), 'utf8').catch(() => null)
console.log('  CLAUDE.md:', claudeMd ? `${claudeMd.length} bytes` : '(none — packaged-only, expected in dev)')

console.log('\nvault:')
for (const dir of ['notes', 'inbox', '_views']) {
  const files = await readdir(join(vault, 'workspace', dir)).catch(() => [])
  console.log(`  ${dir}: ${files.length} file(s)`)
}

await app.close()

console.log('\nerrors seen:', errors.length)
for (const e of [...new Set(errors)].slice(0, 15)) console.log('  ·', e)
