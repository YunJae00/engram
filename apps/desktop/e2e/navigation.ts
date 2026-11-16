import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

export async function openActivity(page: Page, activity: string): Promise<void> {
  if (activity === 'routines') {
    await page.keyboard.press('ControlOrMeta+Shift+P')
    await page.getByRole('option', { name: 'Run a routine…', exact: true }).click()
    return
  }
  if (activity === 'mission') {
    if (!await page.getByTestId('mission-layout-4').isVisible()) await openActivity(page, 'bots')
    if (await page.evaluate(() => innerWidth <= 900) && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
    await page.getByTestId('mission-layout-4').click()
    return
  }
  const sidebar = page.getByTestId('app-sidebar')
  if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(sidebar).toBeVisible()
  const target = page.getByTestId(`activity-${activity}`)
  if (!await target.isVisible()) await page.getByTestId('engram-menu-button').click()
  await target.click()
}

// A broken shutdown should fail promptly instead of spending the whole test timeout in teardown.
export async function closeTestApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const child = app.process()
  // Crash handlers can inherit pipes after the owned Electron process has exited.
  const closePipes = () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() }
  if (child.exitCode !== null || child.signalCode !== null) closePipes()
  else child.once('exit', closePipes)
  try {
    const closing = app.close()
    void app.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
    await Promise.race([closing, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The test app did not shut down within 45 seconds.')), 45000)
    })])
  } catch (error) {
    app.process().kill('SIGKILL')
    throw error
  } finally { clearTimeout(timer) }
}

export async function expandPreview(page: Page | Locator): Promise<void> {
  await expect(page.getByTestId('preview-card')).toBeVisible()
}

export async function openCreateBotDialog(page: Page): Promise<void> {
  await page.evaluate(() => { window.dispatchEvent(new Event('engram:open-create-bot')) })
}

// Selection is not restored on load, so a reload is the way back to the welcome composer.
export async function openWelcome(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
  if (!await page.getByTestId('bots-view').isVisible()) await openActivity(page, 'bots')
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
}

// The sidebar "+" asks for a name (and icon) before it makes the bot, then opens it with the composer focused.
export async function createBotFromPlus(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-create').click()
  await page.getByTestId('create-bot-name').fill(name)
  await page.getByTestId('create-bot-submit').click()
  await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)
}
