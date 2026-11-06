// Mirrors shell.spec.ts: Ctrl/Cmd+P quick-open finds and opens a seeded note.
export async function run(page, { expect }) {
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('Hello')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  return { ok: true, evidence: 'palette query "Hello" opened note-editor showing "The very first note"' }
}
