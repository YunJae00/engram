// Mirrors shell.spec.ts: the list view shows seeded notes, the filter narrows to one, the row opens.
export async function run(page, { expect, openActivity }) {
  await openActivity(page, 'list')
  await expect(page.getByTestId('list-view')).toBeVisible()
  const rows = page.getByTestId('list-row')
  await expect(rows).toHaveCount(3)
  const dates = await page.locator('.list-date').allTextContents()
  const newestFirst = dates.length > 1 && new Set(dates).size === dates.length && [...dates].sort().reverse().join('|') === dates.join('|')
  if (!newestFirst) return { ok: false, evidence: `list dates were not distinct newest-first: ${dates.join(', ')}` }
  await page.getByTestId('list-filter').fill('Hello')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  return { ok: true, evidence: `list-view showed 3 seeded rows newest-first (${dates.join(', ')}), filter "Hello" left 1, row opened note-sheet` }
}
