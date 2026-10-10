import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, fileWorkTools, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-artifact-'))
  paths = await initVault(root, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-artifact-userdata-')),
      ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url)),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
})
test.afterAll(async () => { await app?.close() })

async function screenshot(name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, name), Buffer.from(png, 'base64'))
}

test('created file links open generated artifacts in the thread and reject escaping links', async () => {
  const bot = await createBot(paths, { name: 'File output verification' })
  const tool = fileWorkTools({ directory: join(paths.cache, 'artifacts'), approveRead: async () => false }).find((tool) => tool.name === 'file_create_copy')!
  const artifact = JSON.parse(await tool.run({ name: '검증 결과.json', content: '{"verified":true}' }, { task: 'Create a test artifact.' })) as { path: string; markdownLink: string }
  const markdown = JSON.parse(await tool.run({ name: 'review.md', content: '# Review\n\n**Ready**\n\n<style>body { display: none }</style>\n\n[Run](javascript:alert%281%29)\n\n![Remote](https://example.com/track)\n\n[Docs](https://example.com/docs)' }, { task: 'Create a test artifact.' })) as { markdownLink: string }
  const report = JSON.parse(await tool.run({ name: 'Weekly summary.md', content: '# Weekly summary\n\nThe review is ready.\n\n| Work | Result |\n| --- | --- |\n| Source review | Complete |\n| Draft report | Ready |\n\n## Next steps\n\n- Review the assumptions.\n- Share after approval.\n\n' + Array.from({ length: 12 }, (_, index) => `### Detail ${index + 1}\n\nSupporting information stays readable without moving the file controls.\n`).join('\n') }, { task: 'Create a test artifact.' })) as { markdownLink: string }
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `${artifact.markdownLink}\n\n${markdown.markdownLink}\n\n${report.markdownLink}\n\n[Unavailable output](engram-artifact:../outside.txt)`, at: new Date().toISOString() })
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (path: string) => { (globalThis as unknown as { revealedArtifact: string }).revealedArtifact = path }
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'File output verification' }).click()
  await page.getByRole('link', { name: '검증 결과.json', exact: true }).click()
  const sheet = page.getByTestId('artifact-sheet')
  await expect(sheet).toBeVisible()
  expect(await sheet.evaluate(node => node.matches(':modal'))).toBe(true)
  await expect(sheet.getByTestId('artifact-sheet-text')).toContainText('"verified":true')
  await sheet.getByRole('button', { name: 'Show in folder' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { revealedArtifact: string }).revealedArtifact)).toBe(artifact.path)
  await sheet.getByRole('button', { name: 'Close', exact: true }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(sheet.getByRole('button', { name: 'Show in folder' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('link', { name: '검증 결과.json', exact: true })).toBeFocused()
  await page.getByRole('link', { name: 'review.md', exact: true }).click()
  await expect(sheet.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  await expect(sheet.locator('strong')).toHaveText('Ready')
  await expect(sheet).toContainText('<style>body { display: none }</style>')
  await expect(sheet.locator('style, script, iframe, img')).toHaveCount(0)
  await expect(sheet.getByRole('link')).toHaveCount(1)
  await expect(sheet.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('href', 'https://example.com/docs')
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('link', { name: 'Weekly summary.md', exact: true }).click()
  await expect(sheet.getByRole('heading', { name: 'Weekly summary', exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('index.html'))!.setContentSize(600, 800))
  await page.setViewportSize({ width: 600, height: 800 })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(value => window.engram.settingsSet({ theme: value }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    expect(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
    await screenshot(`artifact-sheet-${theme}-600.png`)
  }
  await sheet.locator('.artifact-sheet-body').evaluate(node => { node.scrollTop = node.scrollHeight })
  await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')
  if (await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-close').click()
  await page.getByRole('link', { name: 'Unavailable output', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This output file is unavailable')
  expect(await app.evaluate(() => (globalThis as unknown as { revealedArtifact: string }).revealedArtifact)).toBe(artifact.path)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})
