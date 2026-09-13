import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { addRoutine, initVault, listCards, listRoutines, type VaultPaths } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-routine-'))
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-routine-userdata-'))
  paths = await initVault(root, { git: false })

  // A local portal stand-in: home → Notices, plus a gated page for the wall.
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/notices')
      res.end('<html><head><title>Notices</title></head><body><main><h1>Notices</h1><p>Holiday notice: the office closes early on Friday.</p></main></body></html>')
    else if (req.url === '/gate')
      res.end(
        gateUnlocked
          ? '<html><head><title>Reports</title></head><body><main><h1>Reports</h1><p>The quarterly numbers landed safely.</p></main></body></html>'
          : '<html><head><title>Sign in</title></head><body><main><h1>Sign in</h1><form><input name="u"/><input type="password" name="p"/></form></main></body></html>',
      )
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

async function openSheet(): Promise<void> {
  // Close whatever overlay an earlier test left, so the sheet mounts fresh
  // and reads the routine list of THIS moment.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('routines-sheet')).toHaveCount(0)
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('engram:open-routines')))
    await expect(page.getByTestId('routines-sheet')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
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

test('a saved routine appears on the sheet as a note in the vault', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await openSheet()

  // Nothing is authored on the sheet: what a comet learned is written to the
  // vault, which is how the one this run replays is handed in.
  await page.evaluate(
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
  // The sheet reads the list when it opens; a note written past it is seen
  // on the next opening.
  await openSheet()

  await expect(page.locator('[data-testid^="routine-row-"]')).toHaveCount(1)
  await expect.poll(async () => (await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
})

test('running a saved routine opens a new chat and lands its reading in the chat and review', async () => {
  const previous = await page.evaluate(() => window.engram.botsList())
  await page.locator('[data-testid^="routine-run-"]').click()
  await expect(page.getByTestId('routines-sheet')).toHaveCount(0)
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

  await openSheet()
  await page.getByTestId(`routine-run-${gated.id}`).click()
  // The wall surfaces as a question in the live block, not as a failure.
  // A wall brings the large view up by itself, with Continue beside the page.
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })

  for (const width of [1180, 1050, 948, 620, 360]) {
    await resizeForRoutine(width)
    await expectRoutineControlReachable('routine-wall-done-live')
  }
  await page.screenshot({ path: test.info().outputPath('routine-login-compact.png') })
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
  await openSheet()
  await page.getByTestId(`routine-run-${gated.id}`).click()
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('web-pane-stop').click()
  await expect(page.getByTestId('routine-wall-done-live')).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(async () => (await listRoutines(paths)).find((routine) => routine.id === gated.id)?.lastOutcome).toBe('aborted')
  gateUnlocked = true
  await openSheet()
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

  await openSheet()
  await page.getByTestId(`routine-run-${writer.id}`).click()

  // The gate shows the actual words that would be posted.
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('routine-submit')).toContainText('shipped the replayer')
  for (const width of [1180, 948, 620, 360]) {
    await resizeForRoutine(width)
    await expectRoutineControlReachable('routine-submit-cancel')
    await expectRoutineControlReachable('routine-submit-approve')
  }
  await page.screenshot({ path: test.info().outputPath('routine-approval-compact.png') })

  // "Not yet" stops the run with the site untouched.
  await page.getByTestId('routine-submit-cancel').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 60_000 })
  expect(posted).toEqual([])
  await page.setViewportSize({ width: 1280, height: 840 })

  // Asked again (the refused run left no success stamp), approving posts once.
  await openSheet()
  await page.getByTestId(`routine-run-${writer.id}`).click()
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-approve').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect.poll(() => posted, { timeout: 20_000 }).toEqual(['shipped the replayer'])

  await openSheet()
  await page.getByTestId(`routine-run-${writer.id}`).click()
  await expect(page.getByTestId('routines-sheet')).toHaveCount(0)
  await expect(page.getByTestId('bots-thread')).toContainText('already ran today')
  await expect(page.getByTestId('bots-offer-run')).toBeVisible()
  expect(posted).toEqual(['shipped the replayer'])
  await page.getByTestId('bots-offer-run').click()
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-cancel').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 60_000 })
  expect(posted).toEqual(['shipped the replayer'])
})

test('scheduled gates stay in the routine sheet and never appear in an unrelated chat', async () => {
  const before = (await page.evaluate(() => window.engram.botsList())).length
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.webContents.send('engram:event', { type: 'routine:step', routineId: 'scheduled-fixture', index: 0, total: 2, label: 'Open scheduled page' })
    window.webContents.send('engram:event', { type: 'routine:wall', routineId: 'scheduled-fixture', wall: 'login' })
    window.webContents.send('engram:event', { type: 'routine:submit', routineId: 'scheduled-fixture', name: 'Scheduled fixture', filled: [{ label: 'Entry', text: 'Fixture content' }], host: 'example.com', canRemember: false })
  })
  await expect(page.locator('.bots-chat').getByTestId('routine-live')).toHaveCount(0)
  await expect(page.locator('.bots-chat').getByTestId('routine-submit')).toHaveCount(0)
  await openSheet()
  const sheet = page.getByTestId('routines-sheet')
  await expect(sheet.getByTestId('routine-live')).toContainText('Open scheduled page')
  await expect(sheet.getByTestId('routine-wall-done-live')).toBeVisible()
  await expect(sheet.getByTestId('routine-submit')).toContainText('Fixture content')
  await expect(sheet.getByTestId('scheduled-routine-stop')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'routine:logged', routineId: 'scheduled-fixture', name: 'Scheduled fixture', outcome: 'aborted' }))
  await expect(sheet.getByTestId('routine-live')).toHaveCount(0)
  await expect(sheet.getByTestId('routine-submit')).toHaveCount(0)
  expect((await page.evaluate(() => window.engram.botsList())).length).toBe(before)
  await page.keyboard.press('Escape')
})
