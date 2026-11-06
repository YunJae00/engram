// Scrap pile: the command palette opens the inbox overlay. Captures wait here; the quick-capture window is the `capture` scenario.
export async function run(page, { expect }) {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('scrap')
  await page.getByRole('option', { name: 'Open scrap pile (inbox)', exact: true }).click()
  await expect(page.getByTestId('inbox-overlay')).toBeVisible()
  await expect(page.getByTestId('inbox-list')).toContainText('Nothing waiting')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox-overlay')).toHaveCount(0)
  return { ok: true, evidence: 'command palette opened inbox-overlay; the fresh vault list said nothing was waiting; Escape closed it' }
}
