import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const SHEET = '11111111-1111-4111-8111-111111111111-sheet.csv'
const REPORT = '22222222-2222-4222-8222-222222222222-report.pdf'
const TURNS = [
  { role: 'user', text: 'Here is the sheet.', at: '2026-01-10T09:00:00.000Z', attachments: ['11111111-1111-4111-8111-111111111111-sheet.csv'] },
  { role: 'assistant', text: 'Made [report.pdf](engram-artifact:22222222-2222-4222-8222-222222222222-report.pdf).\n\nAgain: [report.pdf](engram-artifact:22222222-2222-4222-8222-222222222222-report.pdf)', at: '2026-01-10T09:00:05.000Z' },
  { role: 'user', text: 'Same sheet again.', at: '2026-01-10T09:01:00.000Z', attachments: [SHEET] },
]
let app: ElectronApplication | undefined
let page: Page
const dirs: string[] = []

test.describe.serial('bot info files tab', () => {
  test.beforeAll(async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-bot-files-')), profile = await mkdtemp(join(TMP, 'e2e-bot-files-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    await writeFile(join(vaultPaths(vault).cache, 'bot-chats', 'vis-budget.jsonl'), TURNS.map(turn => JSON.stringify(turn)).join('\n') + '\n')
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('files tab lists each attachment and answer file once and opens the artifact', async () => {
    await page.getByTestId('bot-vis-budget').click()
    await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').last()).toContainText('Same sheet again.')
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await page.locator('#bot-info-tab-files').click()
    const panel = page.locator('#bot-info-panel-files')
    const list = panel.locator('[data-testid="bot-files"]')
    await expect(list).toBeVisible()
    await expect(list.locator('[data-testid="chat-file-card"]:not(.answer-file)')).toHaveCount(1)
    await expect(list.locator('[data-testid="chat-file-card"]:not(.answer-file)')).toContainText('sheet.csv')
    await expect(list.locator('[data-testid="answer-file"]')).toHaveCount(1)
    await expect(list.locator('[data-testid="answer-file"]')).toContainText('report.pdf')
    expect(await list.evaluate(node => {
      const card = node.querySelector('[data-testid="chat-file-card"]:not(.answer-file)'), file = node.querySelector('[data-testid="answer-file"]')
      return !!card && !!file && !!(card.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    await expect(panel.getByTestId('bot-info-empty')).toHaveCount(0)
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.evaluate(() => {
      const seen: unknown[] = []
      Object.assign(window, { seenArtifacts: seen })
      window.addEventListener('engram:open-artifact', event => { seen.push((event as CustomEvent).detail) })
    })
    await list.locator('[data-testid="answer-file"]').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { seenArtifacts: unknown[] }).seenArtifacts)).toEqual([REPORT])
  })
})
