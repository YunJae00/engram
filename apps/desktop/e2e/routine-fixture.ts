import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { openActivity } from './navigation.js'

export function routinePortal(state: { gateUnlocked(): boolean; searchResult(): string; record(entry: string): void }): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/frames')
      res.end('<html><head><title>Embedded portal</title></head><body><iframe src="/frame-content" title="Portal tools"></iframe></body></html>')
    else if (req.url === '/frame-content')
      res.end('<html><body><div id="tools"></div><script>setTimeout(() => { document.getElementById("tools").attachShadow({mode:"open"}).innerHTML = \'<a href="/notices" title="Staff notices">Open notices</a>\' }, 1200)</script></body></html>')
    else if (req.url === '/notices')
      res.end('<html><head><title>Notices</title></head><body><main><h1>Notices</h1><p>Holiday notice: the office closes early on Friday.</p></main></body></html>')
    else if (req.url === '/gate')
      res.end(
        state.gateUnlocked()
          ? '<html><head><title>Reports</title></head><body><main><h1>Reports</h1><p>The quarterly numbers landed safely.</p></main></body></html>'
          : '<html><head><title>Sign in</title></head><body><main><h1>Sign in</h1><form><input name="u"/><input type="password" name="p"/></form></main></body></html>',
      )
    else if (req.url?.startsWith('/search?'))
      res.end(`<html><head><title>Search results</title></head><body><main><h1>Search results</h1><p>${state.searchResult()}</p></main></body></html>`)
    else if (req.url === '/search')
      res.end('<html><head><title>Inventory</title></head><body><main><form method="get" action="/search"><input aria-label="Search inventory" name="q" /></form></main></body></html>')
    else if (req.url?.startsWith('/post')) {
      // POST, not GET: a browser may prefetch a GET form's target on its own,
      // which would look exactly like a post nobody approved.
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        state.record(new URLSearchParams(body).get('entry') ?? '')
        res.end('<html><head><title>Posted</title></head><body><main><h1>Posted</h1></main></body></html>')
      })
    } else if (req.url === '/log')
      res.end(
        '<html><head><title>Log</title></head><body><main><h1>Log</h1>' +
          '<form action="/post" method="post"><input name="entry" aria-label="Entry"/><button type="submit">Submit</button></form>' +
          '</main></body></html>',
      )
    else res.end('<html><head><title>Portal</title></head><body><main><h1>Portal</h1><a href="/notices">Notices</a></main></body></html>')
  })
}

export async function captureRoutine(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    // Wake the hidden window's compositor before capturing the current frame.
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(test.info().outputPath(name), Buffer.from(png, 'base64'))
}

export async function openRoutineView(page: Page, id?: string): Promise<void> {
  await page.keyboard.press('Escape')
  await openActivity(page, 'routines')
  const view = page.getByTestId('routines-view')
  await expect(view).toBeVisible()
  expect(await view.evaluate(node => node.closest('.brief-overlay, [role="dialog"]') === null)).toBe(true)
  if (!id) return
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`sidebar-routine-run-${id}`).click()
  await expect(page.getByTestId(`routine-detail-${id}`)).toBeVisible()
}

export async function expectRoutineControlReachable(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId)
  await control.scrollIntoViewIfNeeded()
  await expect(control).toBeInViewport()
  await expect.poll(() => control.evaluate(node => {
    const box = node.getBoundingClientRect()
    const dock = (node.closest('.bots-write') ?? node.closest('.bots-chat'))!.getBoundingClientRect()
    const pane = document.querySelector('.web-pane')?.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      reachable: node.contains(hit) || hit?.outerHTML.slice(0, 240) || false,
      insideDock: box.left >= dock.left && box.right <= dock.right,
      insideViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      clearOfWebPane: !pane || pane.bottom <= dock.top + 1 || pane.top >= dock.bottom - 1 || pane.left >= dock.right - 1 || pane.right <= dock.left + 1,
    }
  })).toEqual({ reachable: true, insideDock: true, insideViewport: true, clearOfWebPane: true })
  await control.click({ trial: true })
}

export async function resizeForRoutine(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 720 })
  const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  console.info(`[routine layout] requested ${width}x720; actual ${actual.width}x${actual.height}`)
  expect(actual.width).toBeLessThanOrEqual(1180)
  // A closing sidebar stays visible during its animation; do not click it again.
  if (actual.width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') !== 'true' && await page.getByTestId('app-sidebar').isVisible()) {
    await page.getByTestId('app-sidebar-close').click()
    await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true')
  }
}
