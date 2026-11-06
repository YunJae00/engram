// Brain connection with ENGRAM_ENGINE=none: the connect banner opens AI settings and both provider rows.
export async function run(page, { expect }) {
  const banner = page.getByTestId('connect-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'AI settings' }).click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByTestId('settings-nav-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('brain-claude-status')).toBeVisible()
  await expect(page.getByTestId('brain-codex-status')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
  return { ok: true, evidence: 'connect-banner opened AI settings; brain-claude-status and brain-codex-status were visible' }
}
