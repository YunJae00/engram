import { expect, type Page } from '@playwright/test'

export async function openActivity(page: Page, activity: string): Promise<void> {
  const sidebar = page.getByTestId('app-sidebar')
  if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(sidebar).toBeVisible()
  const target = page.getByTestId(`activity-${activity}`)
  if (!await target.isVisible()) await page.getByTestId('workspace-switcher').click()
  await target.click()
}
