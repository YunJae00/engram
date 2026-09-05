// The user's report: two chats, the pane shows the same page on both.
// alpha browses; bravo never does. Looking at bravo must not show alpha's
// picture.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/lanemirror-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/lanemirror-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const a = await createBot(paths, { name: 'alpha', purpose: 'reads pages' })
const b = await createBot(paths, { name: 'bravo', purpose: 'answers from notes' })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await page.getByTestId(`bot-${a.id}`).click()
await page.evaluate(() => window.engram.agentGo('https://example.com/'))
await page.getByTestId('web-pane').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(2_500)
const look = async () => {
  const pane = await page.getByTestId('web-pane').isVisible().catch(() => false)
  const painted = await page.evaluate(`(() => {
    const c = document.querySelector('.mirror-screen canvas')
    if (!c) return 'no canvas'
    const cs = getComputedStyle(c)
    return c.hasAttribute('data-painted') && cs.visibility !== 'hidden' && c.closest('[hidden]') === null ? 'picture shown' : 'no picture'
  })()`)
  const addr = await page.getByTestId('live-address').inputValue().catch(() => '(none)')
  return `pane ${pane ? 'open' : 'gone'} · ${painted} · address "${addr}"`
}
console.log('on alpha (browsed):', await look())
await page.getByTestId(`bot-${b.id}`).click()
await page.waitForTimeout(1_200)
console.log('on bravo (never browsed):', await look())
await page.getByTestId(`bot-${a.id}`).click()
await page.waitForTimeout(1_200)
console.log('back on alpha:', await look())
await app.close()
console.log('lane-mirror-probe: DONE')
