// Quick capture is a second window (#quick), opened through the preload bridge, not a route of the main shell.
export async function run(page, { app, expect }) {
  await page.evaluate(() => globalThis.engram.showQuickComet())
  await expect.poll(() => app.windows().some((window) => window.url().endsWith('#quick'))).toBe(true)
  const popup = app.windows().find((window) => window.url().endsWith('#quick'))
  await expect(popup.getByTestId('quick-capture')).toBeVisible()
  await expect(popup.getByTestId('quick-input')).toBeVisible()
  await popup.getByTestId('quick-input').press('Escape')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().endsWith('#quick'))
    return win ? win.isVisible() : false
  })).toBe(false)
  return { ok: true, evidence: 'showQuickComet opened quick-capture with quick-input; Escape hid the #quick window' }
}
