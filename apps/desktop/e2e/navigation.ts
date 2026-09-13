import { expect, type Page } from '@playwright/test'

export async function openActivity(page: Page, activity: string): Promise<void> {
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
