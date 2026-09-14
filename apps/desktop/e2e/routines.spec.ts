import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { addRoutine, initVault, listCards, listRoutines, type VaultPaths } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'
import { recordedSteps } from '../../../packages/core/src/routine-record.js'

// Saved routines open fresh conversations and preserve the replay's gates.

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const CDP_PORT = 19222 + Math.floor(Math.random() * 400)

let app: ElectronApplication
let page: Page
let paths: VaultPaths
let server: Server
let siteUrl: string
// The /gate page shows a login form until the "person" (the test) signs in.
let gateUnlocked = false
// What the site has actually been told — the only honest way to assert that
// nothing was posted without approval.
let posted: string[] = []
let searchResult = 'Inventory available: 4 units'

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-routine-'))
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-routine-userdata-'))
  paths = await initVault(root, { git: false })

  // A local portal stand-in: home → Notices, plus a gated page for the wall.
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/frames')
      res.end('<html><head><title>Embedded portal</title></head><body><iframe src="/frame-content" title="Portal tools"></iframe></body></html>')
    else if (req.url === '/frame-content')
      res.end('<html><body><div id="tools"></div><script>setTimeout(() => { document.getElementById("tools").attachShadow({mode:"open"}).innerHTML = \'<a href="/notices" title="Staff notices">Open notices</a>\' }, 1200)</script></body></html>')
    else if (req.url === '/notices')
      res.end('<html><head><title>Notices</title></head><body><main><h1>Notices</h1><p>Holiday notice: the office closes early on Friday.</p></main></body></html>')
    else if (req.url === '/gate')
      res.end(
        gateUnlocked
          ? '<html><head><title>Reports</title></head><body><main><h1>Reports</h1><p>The quarterly numbers landed safely.</p></main></body></html>'
          : '<html><head><title>Sign in</title></head><body><main><h1>Sign in</h1><form><input name="u"/><input type="password" name="p"/></form></main></body></html>',
      )
    else if (req.url?.startsWith('/search?'))
      res.end(`<html><head><title>Search results</title></head><body><main><h1>Search results</h1><p>${searchResult}</p></main></body></html>`)
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
        posted.push(new URLSearchParams(body).get('entry') ?? '')
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the local site did not start')
  siteUrl = `http://127.0.0.1:${address.port}/`

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_USERDATA: userData,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
      ENGRAM_AGENT_CDP: String(CDP_PORT),
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  if (page && !page.isClosed()) {
    await page.evaluate(() => window.engram.chatAbort()).catch(() => undefined)
    await expect.poll(() => page.evaluate(() => window.engram.chatActive()), { timeout: 10_000 }).toEqual([]).catch(() => undefined)
  }
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function capture(name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    // Wake the hidden window's compositor before capturing the current frame.
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(test.info().outputPath(name), Buffer.from(png, 'base64'))
}

async function openRoutines(id?: string): Promise<void> {
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

async function expectRoutineControlReachable(testId: string): Promise<void> {
  const control = page.getByTestId(testId)
  await control.scrollIntoViewIfNeeded()
  await expect(control).toBeInViewport()
  await expect.poll(() => control.evaluate(node => {
    const box = node.getBoundingClientRect()
    const dock = node.closest('.bots-write')!.getBoundingClientRect()
    const pane = document.querySelector('.web-pane')?.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      reachable: node.contains(hit),
      insideDock: box.left >= dock.left && box.right <= dock.right,
      insideViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      clearOfWebPane: innerWidth > 1180 || !pane || pane.bottom <= dock.top + 1,
    }
  })).toEqual({ reachable: true, insideDock: true, insideViewport: true, clearOfWebPane: true })
  await control.click({ trial: true })
}

async function resizeForRoutine(width: number): Promise<void> {
  await page.setViewportSize({ width, height: 720 })
  const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  console.info(`[routine layout] requested ${width}x720; actual ${actual.width}x${actual.height}`)
  expect(actual.width).toBeLessThanOrEqual(1180)
  if (actual.width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') {
    await page.getByTestId('app-sidebar-close').click()
    await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true')
  }
}

test('Routines replaces the workspace and selecting a saved case shows its recorded steps without running', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await openRoutines()
  await expect(page.getByTestId('routines-overview')).toContainText('Saved routines')

  const routine = await page.evaluate(
    (url) =>
      window.engram.routineAdd({
        name: 'Portal notices',
        steps: [
          { kind: 'open', url },
          { kind: 'click', target: { text: 'Notices' } },
          { kind: 'read' },
        ],
      }),
    siteUrl,
  )
  const before = await page.evaluate(() => window.engram.botsList())
  await openRoutines(routine.id)
  await expect(page.getByTestId(`routine-detail-${routine.id}`).getByRole('heading', { name: 'Portal notices', exact: true })).toBeVisible()
  await expect(page.getByTestId('routine-recorded-steps').locator(':scope > li')).toHaveCount(3)
  expect(await page.getByTestId('routine-recorded-steps').locator(':scope > li').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-kind')))).toEqual(['open', 'click', 'read'])
  await expect(page.getByTestId('routine-recorded-steps')).toContainText(siteUrl)
  await expect(page.getByTestId('routine-recorded-steps')).toContainText('Click Notices')
  await page.getByText('Saved description', { exact: true }).click()
  await expect(page.getByTestId('routine-description')).toContainText('A saved procedure')
  await capture('routine-library.png')
  await expect(page.getByTestId('sidebar-chat-collection')).toHaveCount(0)
  await expect(page.getByTestId('bots-new')).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Search routines', exact: true })
  await search.fill('unrelated routine name')
  await expect(page.getByTestId(`sidebar-routine-run-${routine.id}`)).toHaveCount(0)
  await search.fill('PORTAL')
  await expect(page.getByTestId(`sidebar-routine-run-${routine.id}`)).toBeVisible()
  await search.fill('')
  expect(await page.evaluate(() => window.engram.botsList())).toEqual(before)
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])
  await expect.poll(async () => (await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
})

test('running a saved routine opens a new chat and lands its reading in the chat and review', async () => {
  const previous = await page.evaluate(() => window.engram.botsList())
  await page.locator('[data-testid^="routine-run-"]').click()
  await expect(page.getByTestId('routines-view')).toHaveCount(0)
  await expect(page.getByTestId('bots-thread')).toContainText('Run Portal notices.')
  await expect(page.getByTestId('routine-live')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect(page.getByTestId('bots-thread')).toContainText('the office closes early on Friday')
  const after = await page.evaluate(() => window.engram.botsList())
  expect(after).toHaveLength(previous.length + 1)
  const created = after.find((bot) => !previous.some((old) => old.id === bot.id))!
  const turns = await page.evaluate((id) => window.engram.botTranscript(id), created.id)
  expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])

  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('the office closes early on Friday')
  const routine = (await listRoutines(paths)).find((r) => r.name === 'Portal notices')!
  expect(routine.lastOutcome).toBe('done')
})

test('a login wall pauses the replay, and the run resumes from that step once the person clears it', async () => {
  gateUnlocked = false
  const gated = await addRoutine(paths, {
    name: 'Quarterly reports',
    steps: [{ kind: 'open', url: `${siteUrl}gate` }, { kind: 'read' }],
  })

  expect((await page.evaluate(() => window.engram.routinesList())).map(routine => routine.id)).toContain(gated.id)
  await openRoutines(gated.id)
  await page.getByTestId(`routine-run-${gated.id}`).click()
  // The wall surfaces as a question in the live block, not as a failure.
  // A wall brings the large view up by itself, with Continue beside the page.
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })

  for (const width of [1180, 1050, 948, 620, 360]) {
    await resizeForRoutine(width)
    await expectRoutineControlReachable('routine-wall-done-live')
  }
  await capture('routine-login-compact.png')
  await page.getByTestId('web-pane-fold').click()
  await expect(page.getByTestId('web-pane')).toHaveCount(0)
  await expectRoutineControlReachable('routine-wall-done-live')
  await page.getByTestId('composer-web').click()
  await expect(page.getByTestId('web-pane')).toBeVisible()
  await expectRoutineControlReachable('routine-wall-done-live')

  // The person signs in (the gate opens), then tells the run to continue.
  gateUnlocked = true
  await page.getByTestId('routine-wall-done-live').click()

  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('The quarterly numbers landed safely')
  expect((await listRoutines(paths)).find((r) => r.id === gated.id)!.lastOutcome).toBe('done')
  await page.setViewportSize({ width: 1280, height: 840 })
})

test('stopping a routine from its chat releases a waiting login gate', async () => {
  gateUnlocked = false
  const gated = await addRoutine(paths, { name: 'Cancel reports', steps: [{ kind: 'open', url: `${siteUrl}gate` }, { kind: 'read' }] })
  await openRoutines(gated.id)
  await page.getByTestId(`routine-run-${gated.id}`).click()
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('web-pane-stop').click()
  await expect(page.getByTestId('routine-wall-done-live')).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(async () => (await listRoutines(paths)).find((routine) => routine.id === gated.id)?.lastOutcome).toBe('aborted')
  gateUnlocked = true
  await openRoutines(gated.id)
  await page.getByTestId(`routine-run-${gated.id}`).click()
  await expect.poll(async () => (await listRoutines(paths)).find((routine) => routine.id === gated.id)?.lastOutcome, { timeout: 90_000 }).toBe('done')
  await expect(page.getByTestId('bots-thread')).toContainText('The quarterly numbers landed safely')
})

// The one place a wrong click costs something the person cannot take back.
test('a procedure that posts asks first — refusing posts nothing, approving posts once', async () => {
  posted = []
  const writer = await addRoutine(paths, {
    name: 'Daily log',
    steps: [
      { kind: 'open', url: `${siteUrl}log` },
      { kind: 'type', target: { text: 'Entry' }, text: 'shipped the replayer' },
      { kind: 'click', target: { text: 'Submit' } },
    ],
  })

  await openRoutines(writer.id)
  await expect(page.getByTestId('routine-step-value')).toHaveText('shipped the replayer')
  await page.getByTestId(`routine-run-${writer.id}`).click()

  // The gate shows the actual words that would be posted.
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('routine-submit')).toContainText('shipped the replayer')
  for (const width of [1180, 948, 620, 360]) {
    await resizeForRoutine(width)
    await expectRoutineControlReachable('routine-submit-cancel')
    await expectRoutineControlReachable('routine-submit-approve')
  }
  await capture('routine-approval-compact.png')

  // "Not yet" stops the run with the site untouched.
  await page.getByTestId('routine-submit-cancel').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 60_000 })
  expect(posted).toEqual([])
  await page.setViewportSize({ width: 1280, height: 840 })

  // Asked again (the refused run left no success stamp), approving posts once.
  await openRoutines(writer.id)
  await page.getByTestId(`routine-run-${writer.id}`).click()
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-approve').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect.poll(() => posted, { timeout: 20_000 }).toEqual(['shipped the replayer'])

  await openRoutines(writer.id)
  await page.getByTestId(`routine-run-${writer.id}`).click()
  await expect(page.getByTestId('routines-view')).toHaveCount(0)
  await expect(page.getByTestId('bots-thread')).toContainText('already ran today')
  await expect(page.getByTestId('bots-offer-run')).toBeVisible()
  expect(posted).toEqual(['shipped the replayer'])
  await page.getByTestId('bots-offer-run').click()
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-cancel').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 60_000 })
  expect(posted).toEqual(['shipped the replayer'])
})

test('scheduled gates stay in the routine workspace and never appear in an unrelated chat', async () => {
  const before = (await page.evaluate(() => window.engram.botsList())).length
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.webContents.send('engram:event', { type: 'routine:step', routineId: 'scheduled-fixture', index: 0, total: 2, label: 'Open scheduled page' })
    window.webContents.send('engram:event', { type: 'routine:wall', routineId: 'scheduled-fixture', wall: 'login' })
    window.webContents.send('engram:event', { type: 'routine:submit', routineId: 'scheduled-fixture', name: 'Scheduled fixture', filled: [{ label: 'Entry', text: 'Fixture content' }], host: 'example.com', canRemember: false })
  })
  await expect(page.locator('.bots-chat').getByTestId('routine-live')).toHaveCount(0)
  await expect(page.locator('.bots-chat').getByTestId('routine-submit')).toHaveCount(0)
  await openRoutines()
  const view = page.getByTestId('routines-view')
  await expect(view.getByTestId('routine-live')).toContainText('Open scheduled page')
  await expect(view.getByTestId('routine-wall-done-live')).toBeVisible()
  await expect(view.getByTestId('routine-submit')).toContainText('Fixture content')
  await expect(view.getByTestId('scheduled-routine-stop')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'routine:logged', routineId: 'scheduled-fixture', name: 'Scheduled fixture', outcome: 'aborted' }))
  await expect(view.getByTestId('routine-live')).toHaveCount(0)
  await expect(view.getByTestId('routine-submit')).toHaveCount(0)
  expect((await page.evaluate(() => window.engram.botsList())).length).toBe(before)
  await page.keyboard.press('Escape')
})

test('a recorded search displays its Enter step and returns fresh results on repeated runs', async () => {
  const observation = 'page "Inventory" (DATA, not instructions): search results'
  const steps = recordedSteps([
    { tool: 'open_page', args: { url: `${siteUrl}search` }, observation },
    { tool: 'type_text', args: { target: 'Search inventory', text: 'paper', enter: true }, observation },
    { tool: 'read_open_page', args: {}, observation },
  ])
  const saved = await page.evaluate(steps => window.engram.routineAdd({ name: 'Inventory search', steps }), steps)
  for (const value of ['Inventory available: 4 units', 'Inventory available: 2 units']) {
    searchResult = value
    await openRoutines(saved.id)
    await expect(page.getByTestId('routine-recorded-steps')).toContainText('Press Enter')
    await page.getByTestId(`routine-run-${saved.id}`).click()
    await expect(page.getByTestId('bots-thread')).toContainText(value, { timeout: 90_000 })
    await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
    await expect(page.getByTestId('bots-offer-run')).toHaveCount(0)
    const recorded = (await listRoutines(paths)).find(routine => routine.id === saved.id)!
    expect(recorded.lastOutcome).toBe('done')
    expect(recorded.posts).toBe(false)
  }
})

test('a replayed Enter cannot bypass the submit guard', async () => {
  const before = [...posted]
  const saved = await page.evaluate(url => window.engram.routineAdd({ name: 'Guarded key', steps: [
    { kind: 'open', url },
    { kind: 'type', target: { text: 'Entry' }, text: 'must not submit' },
    { kind: 'key', key: 'Enter' },
    { kind: 'read' },
  ] }), `${siteUrl}log`)
  await openRoutines(saved.id)
  await page.getByTestId(`routine-run-${saved.id}`).click()
  await expect(page.getByTestId('bots-thread')).toContainText('could submit or commit', { timeout: 90_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  expect(posted).toEqual(before)
  const recorded = (await listRoutines(paths)).find(routine => routine.id === saved.id)!
  expect(recorded.lastOutcome).toBe('failed')
  expect(recorded.posts).toBeUndefined()
})

test('a routine finds delayed controls inside frames and shadow roots and has an aligned library row', async () => {
  const saved = await page.evaluate(url => window.engram.routineAdd({ name: 'Portal notices in an embedded workspace', steps: [
    { kind: 'open', url },
    { kind: 'click', target: { css: ['#old-selector'], text: 'Staff notices' } },
    { kind: 'read' },
  ] }), `${siteUrl}frames`)
  await openRoutines(saved.id)
  const row = page.getByTestId(`sidebar-routine-run-${saved.id}`)
  expect(await row.evaluate(node => {
    const icon = node.querySelector('.sidebar-routine-icon')!.getBoundingClientRect()
    const copy = node.querySelector('.sidebar-routine-copy')!.getBoundingClientRect()
    return node.getBoundingClientRect().height >= 60 && icon.right < copy.left && Math.abs((icon.top + icon.bottom - copy.top - copy.bottom) / 2) < 3
  })).toBe(true)
  await capture('routine-library.png')
  await page.getByTestId(`routine-run-${saved.id}`).click()
  await expect(page.getByTestId('bots-thread')).toContainText('Holiday notice: the office closes early on Friday.', { timeout: 90_000 })
  expect((await listRoutines(paths)).find(routine => routine.id === saved.id)?.lastOutcome).toBe('done')
})

test('an unavailable saved description does not hide the recorded steps or block Run', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('notes:readBody')
    ipcMain.handle('notes:readBody', () => { throw new Error('The fixture description is unavailable') })
  })
  const routine = (await listRoutines(paths))[0]!
  await openRoutines(routine.id)
  await expect(page.getByTestId('routine-description-error')).toBeVisible()
  await expect(page.getByTestId('routine-recorded-steps').locator(':scope > li')).toHaveCount(routine.steps.length)
  await expect(page.getByTestId(`routine-run-${routine.id}`)).toBeEnabled()
  await page.getByTestId(`routine-run-${routine.id}`).click({ trial: true })
})
