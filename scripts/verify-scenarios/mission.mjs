// Mission control: the four-pane split on the comets home. Empty seats are the panels a fresh vault can show.
export async function run(page, { expect, openActivity }) {
  await openActivity(page, 'mission')
  await expect(page.getByTestId('mission-control')).toBeVisible()
  await expect(page.getByTestId('mission-tile-0')).toBeVisible()
  await expect(page.getByTestId('mission-tile-3')).toBeVisible()
  await page.getByTestId('mission-add-0').click()
  await expect(page.getByTestId('mission-add-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mission-add-menu')).toHaveCount(0)
  return { ok: true, evidence: 'mission-layout-4 opened mission-control with tiles 0 and 3; Add a chat opened the chooser and Escape closed it' }
}
