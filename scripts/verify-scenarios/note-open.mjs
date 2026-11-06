// Mirrors shell.spec.ts: clicking a seeded star in the sky opens its note sheet.
export async function run(page, { expect, openActivity }) {
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.getByTestId('cosmos-chat-collapse').click()
  await page.locator('[data-node-id="n-hello-0001"]').click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
  return { ok: true, evidence: 'star n-hello-0001 opened note-sheet showing "The very first note"; Escape closed it' }
}
