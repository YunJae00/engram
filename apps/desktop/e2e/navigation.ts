import { expect, type ElectronApplication, type Page } from '@playwright/test'

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
  if (!await target.isVisible()) await page.getByTestId('workspace-switcher').click()
  await target.click()
}

// A broken shutdown should fail promptly instead of spending the whole test timeout in teardown.
export async function closeTestApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const closing = app.close()
    // Trace flushing precedes Playwright's quit request; request normal quit independently.
    void app.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
    await Promise.race([closing, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The test app did not shut down within 45 seconds.')), 45000)
    })])
  } catch (error) {
    app.process().kill('SIGKILL')
    throw error
  } finally { clearTimeout(timer) }
}
