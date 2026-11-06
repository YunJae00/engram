// Cosmos: the sky, the memory graph, and the docked ask panel. Mirrors the boot and collapse checks in shell.spec.ts.
export async function run(page, { expect, openActivity }) {
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await expect(page.getByTestId('brain-graph')).toBeVisible()
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
  await page.getByTestId('cosmos-chat-collapse').click()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await expect(page.getByTestId('cosmos-chat-open')).toBeVisible()
  await page.getByTestId('cosmos-chat-open').click()
  await expect(page.getByTestId('cosmos-chat-input')).toBeVisible()
  return { ok: true, evidence: 'sky-view showed brain-graph and cosmos-chat; collapse hid the panel and Ask your memory brought cosmos-chat-input back' }
}
