// The shell, topbar and the comets home view render on a fresh vault.
export async function run(page, { expect }) {
  await expect(page.getByTestId('topbar')).toBeVisible()
  await expect(page.getByTestId('bots-view')).toBeVisible()
  return { ok: true, evidence: `shell, topbar and bots-view visible; title "${await page.title()}"` }
}
