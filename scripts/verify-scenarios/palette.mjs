// The command palette was removed: Ctrl/Cmd+P, Ctrl/Cmd+Shift+P, Ctrl/Cmd+Shift+F and Ctrl/Cmd+L open nothing, and the chat composer stays usable.
export async function run(page, { expect }) {
  const input = page.locator('[data-testid="bots-view"] textarea')
  await expect(input).toHaveCount(1)
  for (const keys of ['ControlOrMeta+p', 'ControlOrMeta+Shift+p', 'ControlOrMeta+Shift+f', 'ControlOrMeta+l']) {
    await input.focus()
    await page.keyboard.press(keys)
    await page.waitForTimeout(200)
    await expect(page.getByTestId('palette-input')).toHaveCount(0)
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0)
    await expect(page.getByTestId('note-editor')).toHaveCount(0)
    await expect(page.getByTestId('bots-view')).toBeVisible()
  }
  await input.fill('Hello')
  await expect(input).toHaveValue('Hello')
  return { ok: true, evidence: 'Ctrl/Cmd+P, +Shift+P, +Shift+F and +L opened no palette, dialog or note; the chat composer took "Hello"' }
}
