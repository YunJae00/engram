// Companion to wide-audit.mts: hard numbers for the Brain page geometry.
import { _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))

async function main(): Promise<void> {
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
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1200)
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(500)
  const topic = page.getByTestId('brain-topic').first()
  if (await topic.count()) await topic.click()
  await page.waitForTimeout(500)
  const report = await page.evaluate(() => {
    const out: string[] = []
    for (const sel of ['.brain-view', '.brain-rail', '.brain-scroll', '.brain-page', '.brain-memories']) {
      const el = document.querySelector(sel)
      if (!el) {
        out.push(`${sel}: (missing)`)
        continue
      }
      const r = el.getBoundingClientRect()
      out.push(
        `${sel}: ${r.left.toFixed(0)}..${r.right.toFixed(0)} (w=${r.width.toFixed(0)}) display=${getComputedStyle(el).display} flex=${getComputedStyle(el).flex} justify=${getComputedStyle(el).justifyContent}`,
      )
    }
    return out
  })
  console.log(report.join('\n'))
  await app.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
