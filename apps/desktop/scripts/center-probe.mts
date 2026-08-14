// Why is the List empty state off-centre? Dump the ancestor boxes.
import { _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/sky-empty-vault/', import.meta.url))

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: ROOT,
    ENGRAM_USERDATA: join(ROOT, '.userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_ENGINE: 'none',
  },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1273, height: 837 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(1000)
await page.getByTestId('activity-list').click()
await page.waitForTimeout(500)
const report = await page.evaluate(() => {
  const out: string[] = []
  for (const sel of ['.empty-state', '.empty-title', '.empty-hint', '.empty-state svg']) {
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect()
      out.push(`${sel}: ${r.left.toFixed(0)}..${r.right.toFixed(0)} (center ${((r.left + r.right) / 2).toFixed(0)})`)
    })
  }
  return out
})
console.log(report.join('\n'))
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/center-list.png', import.meta.url)) })
await app.close()
