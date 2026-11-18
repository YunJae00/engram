export async function run(page, { expect }) {
  const input = page.locator('[data-testid="bots-view"] textarea')
  await expect(input).toHaveCount(1)
  await input.focus()
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('palette-input')).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'Open scrap pile (inbox)', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('inbox-overlay')).toHaveCount(0)
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await input.fill('still here')
  await expect(input).toHaveValue('still here')
  return { ok: true, evidence: 'Ctrl/Cmd+Shift+P opened no command palette and no inbox-overlay; the chat composer stayed usable' }
}
