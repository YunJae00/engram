// Settings from the sidebar, then the About section. Mirrors shell.spec.ts "help lives in Settings".
export async function run(page, { expect, openActivity }) {
  await openActivity(page, 'settings')
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.getByTestId('settings-nav-help').click()
  const panel = page.getByTestId('help-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'About', exact: true })).toBeVisible()
  await expect(panel.getByTestId('settings-export-logs')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
  return { ok: true, evidence: 'activity-settings opened settings-view; About showed settings-export-logs; Escape closed settings' }
}
