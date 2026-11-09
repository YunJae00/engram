import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp, openActivity } from './navigation.js'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-new-chat-focus-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-new-chat-focus-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  await page.evaluate(async () => {
    const ids: string[] = []
    for (const name of ['Research scout', 'Release planning']) ids.push((await window.engram.botCreate({ name, purpose: '' })).id)
    localStorage.setItem('engram.mission.slots', JSON.stringify(ids))
  })
})

test.afterAll(async () => { await closeTestApp(app) })

test('a new chat in an empty grid pane takes the keyboard and its body click returns focus to the composer', async () => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openActivity(page, 'mission')
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  const tile = page.getByTestId('mission-tile-2')
  await expect(tile).toHaveClass(/mission-open-seat/)
  const other = page.getByTestId('mission-tile-0').locator('.mini-chat-write textarea')
  await other.fill('Keep this draft')

  await page.getByTestId('mission-add-2').click()
  await page.getByTestId('mission-add-menu').locator('.mission-add-new').click()
  const input = tile.locator('.mini-chat-write textarea')
  await expect(input).toBeFocused()
  await page.keyboard.type('hello')
  await expect(input).toHaveValue('hello')
  await expect(other).toHaveValue('Keep this draft')

  await page.locator('.topbar-title').click()
  await expect(input).not.toBeFocused()
  const body = tile.locator('.mission-tile-body')
  const box = (await body.boundingBox())!
  await page.mouse.click(box.x + 8, box.y + 8)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('hello')
  await expect(other).not.toBeFocused()
})
