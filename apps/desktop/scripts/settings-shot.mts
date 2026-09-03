// Settings sheet snapshot + row geometry. The picture alone was not enough:
// a CSS fix that could not possibly work still LOOKED plausible in the diff
// (.brief-box input { width: 100% } was sizing the checkboxes, which no amount
// of flex on the label could beat). The printed right edges make it checkable.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/settings-shot/', import.meta.url))

await mkdir(OUT, { recursive: true })
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'settings-'))
await initVault(root, { git: false })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: root,
    ENGRAM_USERDATA: join(root, '.userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_ENGINE: 'none',
  },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(1000)
await page.getByTestId('activity-settings').click()
const sheet = page.getByTestId('settings-view')
await sheet.waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await sheet.screenshot({ path: join(OUT, 'settings.png') })
// The connections section, opened: the part that reads as one grey block
// when its margins are wrong.
await page.getByTestId('settings-more').locator('summary').click()
await page.waitForTimeout(300)
await page.getByTestId('setting-audit').scrollIntoViewIfNeeded()
await sheet.screenshot({ path: join(OUT, 'settings-more.png') })

// Every control should stop at one right edge, and no label should wrap.
const rows = await page.evaluate(() => {
  const box = document.querySelector('[data-testid="settings-view"]') as HTMLElement
  const style = getComputedStyle(box)
  const inner = Math.round(box.getBoundingClientRect().right - parseFloat(style.paddingRight))
  return [...box.querySelectorAll('.setting-row:not(.column)')].map((row) => {
    const label = row.querySelector('span')
    const control = row.querySelector('input, select')
    const lineHeight = label ? parseFloat(getComputedStyle(label).lineHeight) || 18 : 18
    return {
      label: label?.textContent?.trim().slice(0, 24) ?? '',
      labelLines: label ? Math.round(label.getBoundingClientRect().height / lineHeight) : 0,
      controlRight: control ? Math.round(control.getBoundingClientRect().right) : null,
      sheetInnerRight: inner,
    }
  })
})
console.log(JSON.stringify(rows, null, 2))

await app.close()
console.log('shot →', OUT)
