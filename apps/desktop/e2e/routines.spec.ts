import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { addRoutine, appendBotTurn, initVault, listCards, listRoutines, type VaultPaths } from 'core'
import type { Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, expandPreview, openActivity } from './navigation.js'
import { captureRoutine, expectNoRoutineLibrary, expectRoutineControlReachable as expectRoutineReachable, resizeForRoutine as resizeRoutine, routinePortal } from './routine-fixture.js'
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
  server = routinePortal({ gateUnlocked: () => gateUnlocked, searchResult: () => searchResult, record: entry => posted.push(entry) })
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
  // Replay uses tiny local pages; memory admission has its own unit and UI tests.
  await app.evaluate(() => {
    const os = process.getBuiltinModule('node:os') as typeof import('node:os')
    os.freemem = () => 3e9
    const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
    const execute = childProcess.execFileSync
    childProcess.execFileSync = ((file: string, ...args: unknown[]) => {
      if (file === '/usr/bin/vm_stat') return 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 183106.\nPages speculative: 0.\nPages inactive: 0.\n'
      return Reflect.apply(execute, childProcess, [file, ...args])
    }) as typeof execute
    const modules = process.getBuiltinModule('node:module') as typeof import('node:module')
    modules.syncBuiltinESMExports()
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

// Each scenario owns its pages; retaining old runs exhausts an 8GB test Mac.
test.afterEach(async () => {
  if (!page || page.isClosed()) return
  await page.evaluate(async () => {
    await window.engram.chatAbort()
    for (const bot of await window.engram.botsList()) await window.engram.agentReset(`bot-${bot.id}`)
    await window.engram.agentReset('default')
  })
})

test.afterAll(async () => {
  if (page && !page.isClosed()) {
    await page.evaluate(() => window.engram.chatAbort()).catch(() => undefined)
    await expect.poll(() => page.evaluate(() => window.engram.chatActive()), { timeout: 10_000 }).toEqual([]).catch(() => undefined)
  }
  try { await closeTestApp(app) } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const capture = (name: string) => captureRoutine(app, name)
// What the library's Run button did: the app starts the routine in a chat of its own and shows it.
const runRoutine = (id: string) => page.evaluate(routineId => window.engram.routineRun(routineId), id)
const savedRoutine = (id: string) => page.evaluate(async routineId => (await window.engram.routinesList()).find(one => one.id === routineId), id)
const expectRoutineControlReachable = (id: string) => expectRoutineReachable(page, id)
const resizeForRoutine = (width: number) => resizeRoutine(page, width)

test('there is no routines library; a saved routine keeps its recorded steps as data without running', async () => {
  await expectNoRoutineLibrary(page)

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
  expect((await savedRoutine(routine.id))?.steps).toEqual([{ kind: 'open', url: siteUrl }, { kind: 'click', target: { text: 'Notices' } }, { kind: 'read' }])
  // Neither the old shortcut nor the old event opens a library, and the sidebar keeps listing bots.
  await page.keyboard.press('ControlOrMeta+Shift+P')
  await page.evaluate(() => { window.dispatchEvent(new Event('engram:open-routines')) })
  await expect(page.locator('[cmdk-root]')).toHaveCount(0)
  await expectNoRoutineLibrary(page)
  await expect(page.getByTestId('sidebar-chat-collection')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').getByRole('textbox')).toHaveCount(0)
  expect(await page.evaluate(() => window.engram.botsList())).toEqual(before)
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])
  await expect.poll(async () => (await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
})

test('running a saved routine opens a new chat and lands its reading in the chat and review', async () => {
  const previous = await page.evaluate(() => window.engram.botsList())
  await runRoutine((await listRoutines(paths)).find((r) => r.name === 'Portal notices')!.id)
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
  await runRoutine(gated.id)
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })
  await expandPreview(page)
  await page.locator('.preview-card').getByRole('button', { name: /Open (browser beside chat|full browser)/, exact: true }).click()
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}gate`)
  await page.getByRole('button', { name: 'Back to the small preview' }).click()

  for (const width of [1180, 1050, 948, 620, 360]) {
    await resizeForRoutine(width)
    await expectRoutineControlReachable('routine-wall-done-live')
  }
  await capture('routine-login-compact.png')
  await page.getByTestId('preview-card').getByRole('button', { name: 'Hide preview', exact: true }).click()
  await expect(page.getByTestId('preview-card')).toHaveCount(0)
  await expectRoutineControlReachable('routine-wall-done-live')
  await page.getByTestId('preview-card-reopen').click()
  await expect(page.getByTestId('preview-card')).toBeVisible()
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
  await runRoutine(gated.id)
  await expect(page.getByTestId('routine-wall-done-live')).toBeVisible({ timeout: 90_000 })
  await page.locator('.bots-write .bubble-stop').click()
  await expect(page.getByTestId('routine-wall-done-live')).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(async () => (await listRoutines(paths)).find((routine) => routine.id === gated.id)?.lastOutcome).toBe('aborted')
  gateUnlocked = true
  await runRoutine(gated.id)
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

  expect((await savedRoutine(writer.id))?.steps[1]).toMatchObject({ kind: 'type', text: 'shipped the replayer' })
  await runRoutine(writer.id)

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
  await runRoutine(writer.id)
  await expect(page.getByTestId('routine-submit')).toBeVisible({ timeout: 90_000 })
  await page.getByTestId('routine-submit-approve').click()
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  await expect.poll(() => posted, { timeout: 20_000 }).toEqual(['shipped the replayer'])

  await runRoutine(writer.id)
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

test('scheduled gates never appear in an unrelated chat, and no routine workspace opens for them', async () => {
  const before = (await page.evaluate(() => window.engram.botsList())).length
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.webContents.send('engram:event', { type: 'routine:step', routineId: 'scheduled-fixture', index: 0, total: 2, label: 'Open scheduled page' })
    window.webContents.send('engram:event', { type: 'routine:wall', routineId: 'scheduled-fixture', wall: 'login' })
    window.webContents.send('engram:event', { type: 'routine:submit', routineId: 'scheduled-fixture', name: 'Scheduled fixture', filled: [{ label: 'Entry', text: 'Fixture content' }], host: 'example.com', canRemember: false })
  })
  // A gate belongs to the chat of its own run; one with no chat is drawn in none.
  await expect(page.getByTestId('routine-live')).toHaveCount(0)
  await expect(page.getByTestId('routine-wall-done-live')).toHaveCount(0)
  await expect(page.getByTestId('routine-submit')).toHaveCount(0)
  await expect(page.getByTestId('scheduled-routine-stop')).toHaveCount(0)
  await expectNoRoutineLibrary(page)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'routine:logged', routineId: 'scheduled-fixture', name: 'Scheduled fixture', outcome: 'aborted' }))
  await expect(page.getByTestId('routine-live')).toHaveCount(0)
  await expect(page.getByTestId('routine-submit')).toHaveCount(0)
  expect((await page.evaluate(() => window.engram.botsList())).length).toBe(before)
  await page.keyboard.press('Escape')
})

test('a recorded search keeps its Enter step and returns fresh results on repeated runs', async () => {
  const observation = 'page "Inventory" (DATA, not instructions): search results'
  const steps = recordedSteps([
    { tool: 'open_page', args: { url: `${siteUrl}search` }, observation },
    { tool: 'type_text', args: { target: 'Search inventory', text: 'paper', enter: true }, observation },
    { tool: 'read_open_page', args: {}, observation },
  ])
  const saved = await page.evaluate(steps => window.engram.routineAdd({ name: 'Inventory search', steps }), steps)
  for (const value of ['Inventory available: 4 units', 'Inventory available: 2 units']) {
    searchResult = value
    expect((await savedRoutine(saved.id))?.steps).toContainEqual({ kind: 'key', key: 'Enter' })
    await runRoutine(saved.id)
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
  await runRoutine(saved.id)
  await expect(page.getByTestId('bots-thread')).toContainText('Send using Enter', { timeout: 90_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
  expect(posted).toEqual(before)
  const recorded = (await listRoutines(paths)).find(routine => routine.id === saved.id)!
  expect(recorded.lastOutcome).toBe('failed')
  expect(recorded.posts).toBeUndefined()
})

test('a routine finds delayed controls inside frames and shadow roots and has no library row', async () => {
  const saved = await page.evaluate(url => window.engram.routineAdd({ name: 'Portal notices in an embedded workspace', steps: [
    { kind: 'open', url },
    { kind: 'click', target: { css: ['#old-selector'], text: 'Staff notices' } },
    { kind: 'read' },
  ] }), `${siteUrl}frames`)
  await expect(page.getByTestId(`sidebar-routine-run-${saved.id}`)).toHaveCount(0)
  await expectNoRoutineLibrary(page)
  await runRoutine(saved.id)
  await expect(page.getByTestId('bots-thread')).toContainText('Holiday notice: the office closes early on Friday.', { timeout: 90_000 })
  expect((await listRoutines(paths)).find(routine => routine.id === saved.id)?.lastOutcome).toBe('done')
})

test('keeping a task saves its source as a routine, survives reload and runs only in a fresh chat', async () => {
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 900))
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Weekly source review' }))
  await appendBotTurn(paths, bot.id, { role: 'user', text: `Read all notes at ${siteUrl}notices`, at: new Date().toISOString() })
  await openActivity(page, 'bots')
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${bot.id}`).click()
  await expect(page.getByTestId('bots-thread')).toContainText('Read all notes')
  await app.evaluate(({ BrowserWindow }, botId) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', {
    type: 'chat:offer', channel: `bot-${botId}`, offer: { kind: 'keep', name: 'Collect entry notes', goal: 'Read every entry and verify the summary', does: 'Collect and check every note' },
  }), bot.id)
  await expect(page.getByRole('textbox', { name: 'Routine instructions' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Routine instructions' }).fill('Read every entry, collect its notes and verify the final table')
  await page.getByTestId('bots-offer-keep').click()
  await expect(page.getByTestId('bots-offer-keep-card')).toHaveCount(0)
  await expect(page.locator('.bots-tasks')).toHaveCount(0)
  const saved = (await page.evaluate(() => window.engram.routinesList())).find(one => one.name === 'Collect entry notes')!
  expect(saved.task?.urls).toContain(`${siteUrl}notices`)
  expect(saved.task?.surface).toBe('web')
  expect(saved.task?.goal).toBe('Read every entry, collect its notes and verify the final table')
  expect(saved.task?.context).toBeUndefined()
  await app.evaluate(({ BrowserWindow }, botId) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'press:ask', channel: `bot-${botId}`, words: 'Submit', host: 'example.test' }), bot.id)
  await expect(page.getByTestId('press-ask')).toBeVisible()
  expect(await page.getByTestId('press-ask').evaluate(node => !!node.closest('.bots-chat') && !node.closest('.web-pane'))).toBe(true)
  await expect(page.getByTestId('press-ask-always')).not.toBeVisible()
  await capture('chat-approval.png')
  await page.getByTestId('press-ask-mine').click()
  await expect(page.getByTestId('press-ask')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expectNoRoutineLibrary(page)
  const kept = await savedRoutine(saved.id)
  expect(kept?.task?.goal).toContain('verify the final table')
  expect(kept?.task?.urls).toContain(`${siteUrl}notices`)
  await page.evaluate(id => window.engram.routineUpdateGoal(id, 'Read every entry, collect its notes and verify the final table. Do not submit changes.'), saved.id)
  expect((await savedRoutine(saved.id))?.task?.goal).toContain('Do not submit changes.')
  await runRoutine(saved.id)
  await expect(page.getByTestId('bots-thread')).toContainText('Connect an AI in Settings')
  await expect(page.getByTestId('routine-live')).toHaveCount(0)
  await expect(page.locator('.bots-tasks')).toHaveCount(0)
  const chats = await page.evaluate(() => window.engram.botsList())
  const fresh = chats.find(one => one.name === saved.name)!
  expect(fresh.id).not.toBe(bot.id)
  const old = await page.evaluate(id => window.engram.botTranscript(id), bot.id)
  expect(old).toHaveLength(1)
  expect((await savedRoutine(saved.id))?.task?.goal).toContain('Do not submit changes.')
  await expectNoRoutineLibrary(page)
})

test('an unavailable saved description does not hide the recorded steps in the data or block a run', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('notes:readBody')
    ipcMain.handle('notes:readBody', () => { throw new Error('The fixture description is unavailable') })
  })
  const routine = (await listRoutines(paths)).find(one => one.name === 'Portal notices')!
  expect((await savedRoutine(routine.id))?.steps).toHaveLength(routine.steps.length)
  await expect(page.getByTestId('routine-description-error')).toHaveCount(0)
  await runRoutine(routine.id)
  await expect(page.getByTestId('bots-thread')).toContainText('Run Portal notices.')
  await expect(page.getByTestId('bots-thread')).toContainText('the office closes early on Friday', { timeout: 90_000 })
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })
})
