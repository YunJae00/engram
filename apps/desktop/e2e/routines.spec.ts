import { expect, test, _electron as electron, chromium, type Browser, type ElectronApplication, type Page } from '@playwright/test'
import { addRoutine, initVault, listCards, listRoutines, type VaultPaths } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The routine replayer end to end: build a routine in the sheet, TEACH one by
// doing the work in a real Chrome, and replay through a login wall that a
// person clears mid-run. The agent browser is a real Chrome the main process
// drives; the test reaches into that window over CDP to stand in for the
// person's hands.

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

// The agent Chrome takes a few seconds to come up; keep knocking on its CDP
// door until it answers. A previous run's window may still be shutting down
// and still holding the port, so only the freshly opened teach window — the
// one sitting on about:blank — counts as an answer.
async function connectAgent(): Promise<Browser> {
  let last: unknown
  for (let i = 0; i < 60; i++) {
    let browser: Browser | null = null
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
      const open = browser.contexts()[0]?.pages() ?? []
      if (open.length > 0 && open.every((one) => one.url() === 'about:blank')) return browser
      await browser.close()
    } catch (err) {
      last = err
      await browser?.close().catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw last ?? new Error('the teach window never appeared on the debug port')
}

test('the builder saves a routine a non-developer could author', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await openSheet()

  await page.getByTestId('routines-new').click()
  await page.getByTestId('routine-name').fill('Portal notices')
  await page.getByTestId('routine-step-url-0').fill(siteUrl)
  await page.getByTestId('routine-add-step').click()
  await page.getByTestId('routine-step-kind-1').selectOption('click')
  await page.getByTestId('routine-step-target-1').fill('Notices')
  await page.getByTestId('routine-add-step').click()
  await page.getByTestId('routine-step-kind-2').selectOption('read')
  await page.getByTestId('routine-save').click()

  await expect(page.locator('[data-testid^="routine-row-"]')).toHaveCount(1)
  await expect.poll(async () => (await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
})

test('running the routine drives a real Chrome and lands the reading in review', async () => {
  await page.locator('[data-testid^="routine-run-"]').click()
  await expect(page.getByTestId('routine-live')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })

  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('the office closes early on Friday')
  const routine = (await listRoutines(paths)).find((r) => r.name === 'Portal notices')!
  expect(routine.lastOutcome).toBe('done')
})

test('teach mode records the work as done in the agent window — and replays it', async () => {
  // A machine with several browsers installed is asked which one to work in
  // before anything is recorded; a CI runner is such a machine. The person
  // picks in Settings - here the pick is made the same way, through the API.
  await page.evaluate(async () => {
    const installed = (await window.engram.browsersInstalled()) as { path: string }[]
    if (installed[0]) await window.engram.browserChoose(installed[0].path)
  })
  await openSheet()
  await page.getByTestId('routines-teach').click()
  // A cold Chrome launch on a busy runner can take a while.
  await expect(page.getByTestId('routine-teach')).toBeVisible({ timeout: 60_000 })

  // The person's hands: walk the portal in the agent Chrome itself.
  const agent = await connectAgent()
  try {
    const agentPage = agent.contexts()[0]!.pages()[0]!
    await agentPage.goto(siteUrl, { waitUntil: 'domcontentloaded' })
    await agentPage.click('a', { timeout: 10_000 })
    await agentPage.waitForURL('**/notices', { timeout: 10_000 })
  } finally {
    await agent.close().catch(() => undefined)
  }

  await page.getByTestId('routine-teach-read').click()
  await page.getByTestId('routine-teach-done').click()

  // The captured steps wait under a name box: open → click → read.
  await expect(page.getByTestId('routine-taught')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('routine-taught').locator('.errand-step')).toHaveCount(3)
  await page.getByTestId('routine-taught-name').fill('Taught notices')
  await page.getByTestId('routine-taught-save').click()
  await expect(page.locator('[data-testid^="routine-row-"]')).toHaveCount(2)

  // The taught routine replays like any other and brings the reading home.
  const taught = (await listRoutines(paths)).find((r) => r.name === 'Taught notices')!
  await page.getByTestId(`routine-run-${taught.id}`).click()
  await expect(page.getByTestId('routine-live')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('Taught notices')
  expect((await listRoutines(paths)).find((r) => r.id === taught.id)!.lastOutcome).toBe('done')
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
  await expect(page.getByTestId('routine-wall-done')).toBeVisible({ timeout: 90_000 })

  // The person signs in (the gate opens), then tells the run to continue.
  gateUnlocked = true
  await page.getByTestId('routine-wall-done').click()

  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('The quarterly numbers landed safely')
  expect((await listRoutines(paths)).find((r) => r.id === gated.id)!.lastOutcome).toBe('done')
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

  // "Not yet" stops the run with the site untouched.
  await page.getByTestId('routine-submit-cancel').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 60_000 })
  expect(posted).toEqual([])

  // Asked again (the refused run left no success stamp), approving posts once.
  await openSheet()
  await page.getByTestId(`routine-run-${writer.id}`).click()
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-approve').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect.poll(() => posted, { timeout: 20_000 }).toEqual(['shipped the replayer'])
})
