// Does folding the floating bubble away drag the MAIN window forward?
// Report: "press the bubble button to open it, then press minimize — and
// suddenly the MAIN app window pops up." The suspect is collapse's win.blur():
// on macOS BrowserWindow.blur() is [window orderOut:] + [window orderBack:],
// which drops the bubble out of the window list and hands key/main status to
// the next window in the app — the shell — and, with the shell hidden to the
// tray, leaves the app with no on-screen window at all, which is the state
// AppKit answers with a reopen → app 'activate' → showMainWindow().
//
// Playwright clicks are synthetic and never make the app frontmost, so none of
// this is observable until the app is REALLY activated: hence the System Events
// hop below. Without it every window reads focused=false and the probe is blind.
import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'bubble-'))
const paths = await initVault(root, { git: false })
await createNote(paths, { id: 'n-hello-0001', body: '# Hello note\n\nThe very first note.' })

// NOT ENGRAM_HIDDEN=1: that flag skips startBubble entirely (index.ts), so the
// window under test would not exist.
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})

// Unpackaged Electron shows up under its own process name, never "Engram" —
// an installed copy running alongside is left alone.
function osa(script: string): string {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
  } catch (err) {
    return `(osascript failed: ${String(err).split('\n')[1]})`
  }
}

const activateApp = (): string => osa('tell application "System Events" to set frontmost of process "Electron" to true')
// Front-to-back, which is the thing the user actually reports seeing.
const frontmostApp = (): string => osa('tell application "System Events" to get name of first process whose frontmost is true')
const zOrder = (): string => osa('tell application "System Events" to tell process "Electron" to get name of every window')

interface Snap {
  kind: 'bubble' | 'main'
  visible: boolean
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

const snap = async (): Promise<Snap[]> =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      kind: (w.webContents.getURL().includes('#bubble') ? 'bubble' : 'main') as 'bubble' | 'main',
      visible: w.isVisible(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
    })),
  )

const show = (label: string, rows: Snap[]): void => {
  console.log(`  ${label}`)
  for (const r of rows) {
    console.log(
      `    ${r.kind.padEnd(6)} visible=${String(r.visible).padEnd(5)} focused=${String(r.focused).padEnd(5)} ` +
        `${r.bounds.width}x${r.bounds.height} @ ${r.bounds.x},${r.bounds.y}`,
    )
  }
  console.log(`    frontmost app: ${frontmostApp()}   app windows front→back: ${zOrder()}`)
}

const shell = await app.firstWindow()
await shell.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
const bubble = app.windows().find((w) => w.url().includes('#bubble')) ?? (await app.waitForEvent('window'))
await bubble.getByTestId('bubble-dot').waitFor({ state: 'visible', timeout: 30_000 })

let failures = 0

// Two starting states, because they go wrong differently: a shell hidden to the
// tray must STAY hidden, and a shell merely sitting behind must stay behind.
for (const hideMain of [true, false]) {
  console.log(`\n════ main window ${hideMain ? 'hidden to tray' : 'visible, in the background'} ════`)
  // Activate first, THEN hide: activating an app whose windows are all off
  // screen is itself a reopen, and that path is not what is under test here.
  activateApp()
  await shell.waitForTimeout(500)
  await app.evaluate(({ BrowserWindow }, hide) => {
    const wins = BrowserWindow.getAllWindows()
    const main = wins.find((w) => !w.webContents.getURL().includes('#bubble'))
    if (hide) main?.hide()
    else main?.showInactive()
    // Clicking the dot is what makes the bubble key — Playwright's synthetic
    // click cannot, so say it out loud.
    wins.find((w) => w.webContents.getURL().includes('#bubble'))?.focus()
  }, hideMain)
  await shell.waitForTimeout(800)

  const before = await snap()
  show('before expand', before)

  await bubble.getByTestId('bubble-dot').click()
  await bubble.getByTestId('bubble-chat').waitFor({ state: 'visible', timeout: 15_000 })
  await bubble.waitForTimeout(800)
  show('after expand', await snap())

  await bubble.getByRole('button', { name: 'Minimize to button' }).click()
  await bubble.getByTestId('bubble-dot').waitFor({ state: 'visible', timeout: 15_000 })
  await bubble.waitForTimeout(1_000)
  const after = await snap()
  show('after collapse', after)

  const mainBefore = before.find((r) => r.kind === 'main')!
  const mainAfter = after.find((r) => r.kind === 'main')!
  const ok = mainBefore.visible === mainAfter.visible && mainBefore.focused === mainAfter.focused
  if (!ok) failures += 1
  console.log(
    `\n  main   visible ${mainBefore.visible} → ${mainAfter.visible}   focused ${mainBefore.focused} → ${mainAfter.focused}   ` +
      (ok ? 'UNCHANGED ✓' : 'CHANGED ✗'),
  )
  const dot = after.find((r) => r.kind === 'bubble')!
  console.log(`  bubble ${dot.bounds.width}x${dot.bounds.height} visible=${dot.visible} focused=${dot.focused}`)
}

await app.close()
console.log(failures === 0 ? '\nboth scenarios clean' : `\n${failures} scenario(s) moved the main window`)
process.exit(failures === 0 ? 0 : 1)
