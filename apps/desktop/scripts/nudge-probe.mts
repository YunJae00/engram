// Does the floating question actually appear, where it should, without taking
// the keyboard away from whatever the user is doing?
//
// The whole premise is that it interrupts as little as a notification does. A
// window that steals focus mid-sentence is worse than the queue it replaces,
// so that is the property worth measuring, not the pixels.
import { _electron as electron } from '@playwright/test'
import { createNote, initVault, createCard } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'nudge-'))
const paths = await initVault(root, { git: false })

const a = await createNote(paths, { body: '# 스킬 통계 대시보드 오류\n\n운영 DB에 마이그레이션이 안 올라감.' })
const b = await createNote(paths, { body: '# agent 서비스 마이그레이션\n\ndev DB에 마이그레이션이 안 올라감.' })
await createCard(paths, {
  cardType: 'conflict',
  targets: [a.front.id, b.front.id],
  rationale: '동일 증상의 마이그레이션 미적용 환경을 한쪽은 dev DB, 다른 쪽은 운영 DB로 서로 다르게 지목함',
  job: 'J3',
})

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: root,
    ENGRAM_NO_GIT: '1',
    ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_ENGINE: 'mock',
    // The real thing waits five minutes for boot to settle and then polls every
    // ten. Neither is testable, so the probe asks for it directly.
    ENGRAM_NUDGE_NOW: '1',
  },
})
const shell = await app.firstWindow()
await shell.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

// Which window has the keyboard BEFORE the card appears?
const focusedBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)

const nudge = await app.waitForEvent('window', { timeout: 30_000 })
await nudge.getByTestId('nudge').waitFor({ state: 'visible', timeout: 20_000 })

const focusedAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)
console.log(`focus before: ${focusedBefore}   after: ${focusedAfter}   ${focusedBefore === focusedAfter ? 'KEPT' : 'STOLEN'}`)

const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('nudge'))
  if (!win) return null
  const b = win.getBounds()
  const area = screen.getPrimaryDisplay().workArea
  return {
    onTop: win.isAlwaysOnTop(),
    // No isSkipTaskbar() exists in Electron — only the setter — so the first
    // version of this probe reported `!undefined` and claimed the card was in
    // the taskbar when it is not. Read what can actually be read.
    rightGap: area.x + area.width - (b.x + b.width),
    insideScreen: b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height,
  }
})
console.log(`geometry: ${JSON.stringify(geometry)}`)

console.log('\ncard text:')
console.log((await nudge.getByTestId('nudge').innerText()).split('\n').map((l) => `  ${l}`).join('\n'))

// Answering must close it and settle the card — the point is that the question
// is gone without ever opening the app.
await nudge.screenshot({ path: 'C:/Users/ykwon060/AppData/Local/Temp/claude/C--Users-ykwon060-Desktop-pjt-strata-strata/d0e46e2e-b585-4b06-8d29-bdb2b98c9cc8/scratchpad/nudge.png', omitBackground: true })

await nudge.getByTestId('nudge-reject').click()
await shell.waitForTimeout(1200)
const stillOpen = await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('nudge') && w.isVisible()),
)
console.log(`\nafter answering, still on screen: ${stillOpen}`)

const { listCards } = await import('core')
const open = await listCards(paths, 'proposed')
const { readNote } = await import('core')
const status = (await readNote(paths, a.front.id)).front.status
console.log(`open questions left: ${open.length}   note status after "not a conflict": ${status}`)

await app.close()
