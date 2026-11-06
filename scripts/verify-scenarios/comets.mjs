// Comets home on a vault with no conversation selected: the welcome composer, and no cosmos furniture.
export async function run(page, { expect }) {
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await expect(page.getByTestId('welcome-input')).toBeVisible()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+l')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  return { ok: true, evidence: 'bots-view showed comet-welcome and welcome-input; cosmos-chat stayed off the comets tab; Ctrl/Cmd+L kept bots-view' }
}
