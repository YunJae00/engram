import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const VAULT = resolve('../../tmp/eval-vault')
const OUT = resolve('../../tmp/field-shots')
async function main() {
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({ args: [MAIN_ENTRY, '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: join(VAULT, '.userdata'), ENGRAM_NO_GIT: '1', ENGRAM_ENGINE: 'none' } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2000)
  const shot = async (n: string) => { await page.screenshot({ path: join(OUT, `${n}.png`) }); console.log('shot:', n) }
  await shot('01-board-rail-flat')
  await page.getByTestId('remember-button').click()
  await page.waitForTimeout(400)
  await shot('02-composer-no-tape')
  await page.getByTestId('chat-close').click()
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(1200)
  const topics = page.getByTestId('brain-topic')
  if (await topics.count() > 1) { await topics.nth(1).click(); await page.waitForTimeout(600) }
  await shot('03-brain-selected')
  const constellation = page.getByRole('button', { name: /constellation|별자리/i }).first()
  if (await constellation.count()) {
    await constellation.click()
    await page.waitForTimeout(900)
    await shot('04-constellation-full')
    const svg = page.getByTestId('brain-graph')
    if (await svg.count()) { await svg.hover(); for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -240); await page.waitForTimeout(500); await shot('05-constellation-zoomed') }
  } else console.log('(no constellation button found)')
  await app.close()
}
void main()
