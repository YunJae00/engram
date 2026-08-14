import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/chrome-shots/', import.meta.url))

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
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
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('scrap-pile').waitFor({ state: 'visible', timeout: 10_000 })

  await page.evaluate(() => {
    const widget = document.createElement('div')
    widget.className = 'absorb-widget'
    widget.innerHTML =
      '<div class="absorb-head"><span class="absorb-title">Librarian at work</span></div>' +
      '<div class="absorb-progress"><div class="absorb-track"><div class="absorb-fill" style="width:50%"></div></div>' +
      '<div class="absorb-caption">1/2 · 50%</div></div>' +
      '<div class="absorb-stage">2/2 · Absorbing notes</div>' +
      '<div class="absorb-elapsed">00:04</div>' +
      '<div class="absorb-actions"><button class="absorb-btn">Stop after this step</button></div>'
    document.body.appendChild(widget)
    document.querySelector('.scrap-pile')?.classList.add('beside-widget')
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = 'Captured — the librarian is filing it'
    document.body.appendChild(toast)
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'bottom-left.png'), clip: { x: 0, y: 560, width: 560, height: 340 } })
  await page.screenshot({ path: join(OUT, 'bottom-right.png'), clip: { x: 1000, y: 700, width: 440, height: 200 } })
  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
