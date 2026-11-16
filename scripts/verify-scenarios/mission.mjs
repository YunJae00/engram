// One chat view: the four-pane split (mission control) was removed. No split buttons, no tiles; the chat composer is what a fresh vault shows.
export async function run(page, { expect }) {
  await expect(page.getByTestId('bots-view')).toHaveCount(1)
  for (const id of ['mission-layout-1', 'mission-layout-2', 'mission-layout-4', 'mission-control', 'mission-tile-0', 'mission-add-0', 'mission-add-menu', 'activity-mission']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(page.locator('.mini-chat, .mission-preview')).toHaveCount(0)
  const input = page.locator('[data-testid="bots-view"] textarea')
  await expect(input).toHaveCount(1)
  await input.fill('one chat')
  await expect(input).toHaveValue('one chat')
  return { ok: true, evidence: 'one bots-view with one composer; no mission-layout buttons, mission-control, tiles or mini chats; the composer took typed text' }
}
