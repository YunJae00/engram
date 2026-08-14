// Does Ctrl+Shift+P still open the palette after an overlay closes on Escape?
// Two e2e tests that drive the palette started failing on Electron 43 while
// passing on 33, and the failing step is the shortcut itself — so the question
// is whether a HUMAN is affected or only the serial test chain. This walks the
// exact sequence by hand and reports each step.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'palette-probe-'))
await initVault(root, { git: false })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(800)

const shows = async (id: string) => (await page.getByTestId(id).count()) > 0

// 1. cold: does the shortcut work at all?
await page.keyboard.press('ControlOrMeta+Shift+p')
await page.waitForTimeout(600)
console.log('1. cold Ctrl+Shift+P          → palette:', await shows('palette-input'))
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// 2. the sequence the e2e chain performs: open Today, Escape, then shortcut
await page.getByTestId('today-button').click()
await page.getByTestId('today-sheet').waitFor({ state: 'visible', timeout: 10_000 })
console.log('2. Today opened               → sheet:', await shows('today-sheet'))
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
console.log('3. Escape closed Today        → sheet:', await shows('today-sheet'))

await page.keyboard.press('ControlOrMeta+Shift+p')
await page.waitForTimeout(600)
const afterEscape = await shows('palette-input')
console.log('4. Ctrl+Shift+P after Escape  → palette:', afterEscape)

// 3. what has focus at that moment — the likely difference between Chromium versions
const focus = await page.evaluate(() => {
  const el = document.activeElement
  return {
    tag: el?.tagName ?? '(none)',
    testid: el?.getAttribute?.('data-testid') ?? null,
    inDocument: el ? document.contains(el) : false,
    isBody: el === document.body,
  }
})
console.log('5. document.activeElement     →', JSON.stringify(focus))

// 4. does a click anywhere restore it? (tells us whether a human recovers)
if (!afterEscape) {
  await page.getByTestId('shell').click({ position: { x: 5, y: 400 } })
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.waitForTimeout(600)
  console.log('6. after clicking the shell   → palette:', await shows('palette-input'))
}

// 5. THE ONE THAT MATTERS: can the palette be driven by keyboard at all?
// cmdk marks the row [selected] and Enter is supposed to run it. In the e2e
// failure the option was selected and Enter did nothing.
if (!(await shows('palette-input'))) {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.getByTestId('palette-input').waitFor({ state: 'visible', timeout: 10_000 })
}
await page.getByTestId('palette-input').fill('weekly digest')
await page.getByRole('option', { name: 'Read the weekly digest' }).waitFor({ state: 'visible', timeout: 10_000 })
console.log('7. option selected            → yes')
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)
const byEnter = await shows('digest-sheet')
console.log('8. Enter runs the option      → digest sheet:', byEnter)

if (!byEnter) {
  // Does the mouse still work? Separates "cmdk is dead" from "Enter is dead".
  await page.getByRole('option', { name: 'Read the weekly digest' }).click()
  await page.waitForTimeout(1500)
  console.log('9. clicking the option        → digest sheet:', await shows('digest-sheet'))
}

await app.close()
console.log(
  byEnter
    ? 'VERDICT: palette keyboard path OK on this Electron'
    : 'VERDICT: Enter does NOT activate the palette option — user-facing regression',
)
