import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const PREVIEW = join(TMP, 'work-interview-preparation-preview')
const QUESTIONS = [{ topic: 'outputs', question: 'How should I prepare a project update?', basis: '', source: 'task-0123456789abcdef01234567', options: ['Prepare a short draft.', 'Link to the source.'] }]
type Fixture = { setupRequests: Array<{ id: string; resolve(questions: typeof QUESTIONS): void; reject(error: Error): void }>; setupCanceled: number }
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  await mkdir(PREVIEW, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-interview-preparation-'))
  await initVault(join(root, 'vault'), { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: join(root, 'vault'), ENGRAM_USERDATA: join(root, 'profile'),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 600, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & Fixture
    state.setupRequests = []; state.setupCanceled = 0
    for (const channel of ['interview:questions', 'interview:save', 'interview:cancel']) ipcMain.removeHandler(channel)
    ipcMain.handle('interview:questions', (_event, options: { requestId: string }) => new Promise<typeof QUESTIONS>((resolve, reject) => state.setupRequests.push({ id: options.requestId, resolve, reject })))
    ipcMain.handle('interview:save', () => ({ saved: true }))
    ipcMain.handle('interview:cancel', () => { state.setupCanceled++ })
  })
})
test.afterEach(async () => { await app?.close() })

async function openInterview() {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-memory').click()
  await page.getByTestId('interview-open').click()
  await expect(page.getByTestId('interview-dialog')).toBeVisible()
}

async function progress(at: number, phase: 'mapping' | 'filing' | 'questions', stage?: 'capture' | 'organize', completed?: number, total?: number) {
  await app.evaluate(({ BrowserWindow }, value) => {
    const requestId = (globalThis as typeof globalThis & Fixture).setupRequests[value.at]!.id
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'interview:progress', requestId, phase: value.phase, stage: value.stage, completed: value.completed, total: value.total })
  }, { at, phase, stage, completed, total })
}

async function screenshot(name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
  await writeFile(join(PREVIEW, name), Buffer.from(png, 'base64'))
}

test('settings prepare only on request and show measured stages before questions', async () => {
  await openInterview()
  expect(await app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(0)
  await expect(page.getByTestId('interview-start')).toBeVisible()
  await page.clock.install()
  await page.getByTestId('interview-start').click()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(1)
  await expect(page.getByTestId('interview-phase')).toHaveText('Starting setup…')
  await expect(page.getByTestId('interview-file-count')).toHaveCount(0)
  await progress(0, 'mapping')
  await expect(page.getByTestId('interview-phase')).toHaveText('Finding your work places…')
  await page.clock.runFor(21_000)
  await expect(page.getByRole('timer')).toHaveText(/0:2\d/)
  await progress(0, 'filing', 'capture', 2, 5)
  await expect(page.getByTestId('interview-phase')).toHaveText('Filing your first captures…')
  await expect(page.getByTestId('interview-file-count')).toHaveText('2 / 5 completed')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    expect(await page.getByTestId('interview-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(page.getByTestId('interview-start-now')).toBeInViewport()
    await screenshot(`filing-${theme}-600.png`)
  }
  await progress(0, 'filing', 'organize', 1, 3)
  await expect(page.getByTestId('interview-phase')).toHaveText('Organizing Cosmos…')
  await expect(page.getByTestId('interview-file-count')).toHaveText('1 / 3 completed')
  await screenshot('organizing-dark-600.png')
  await progress(0, 'questions')
  await expect(page.getByTestId('interview-phase')).toHaveText('Preparing questions…')
  await expect(page.getByTestId('interview-file-count')).toHaveCount(0)
  await app.evaluate((_electron, questions) => (globalThis as typeof globalThis & Fixture).setupRequests[0]!.resolve(questions), QUESTIONS)
  await expect(page.getByTestId('interview-question-0')).toBeVisible()
  await expect(page.getByTestId('interview-wait')).toHaveCount(0)
})

test('unfinished preparation offers retry and ignores old request progress', async () => {
  await openInterview()
  await page.getByTestId('interview-start').click()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(1)
  await progress(0, 'filing', 'capture', 1, 4)
  await app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests[0]!.reject(new Error('Fixture deferred')))
  await expect(page.getByRole('alert')).toContainText('Cosmos preparation paused before it finished')
  await expect(page.getByRole('heading', { name: 'Nothing to ask yet' })).toHaveCount(0)
  await expect(page.getByTestId('interview-start')).toHaveText('Retry')
  await expect(page.getByTestId('interview-later')).toHaveText('Start now')
  await screenshot('paused-light-600.png')
  await page.getByTestId('interview-start').click()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(2)
  expect(await app.evaluate(() => new Set((globalThis as typeof globalThis & Fixture).setupRequests.map(one => one.id)).size)).toBe(2)
  await progress(0, 'filing', 'organize', 999, 999)
  await expect(page.getByTestId('interview-phase')).toHaveText('Starting setup…')
  await expect(page.getByTestId('interview-file-count')).toHaveCount(0)
  await progress(1, 'filing', 'capture', 1, 3)
  await expect(page.getByTestId('interview-file-count')).toHaveText('1 / 3 completed')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('interview-start')).toBeVisible()
  await progress(1, 'questions')
  await app.evaluate((_electron, questions) => (globalThis as typeof globalThis & Fixture).setupRequests[1]!.resolve(questions), QUESTIONS)
  await expect(page.getByTestId('interview-question-0')).toHaveCount(0)
  await expect(page.getByTestId('interview-start')).toBeVisible()
})

test('first-run setup waits for a connected engine, starts once and can be left or completed', async () => {
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['app:tourEligible', 'engines:isDetected', 'engines:list']) ipcMain.removeHandler(channel)
    ipcMain.handle('app:tourEligible', () => true)
    ipcMain.handle('engines:isDetected', () => false)
    ipcMain.handle('engines:list', () => [])
  })
  await page.evaluate(() => { localStorage.setItem('engram.tour.done', '1'); localStorage.setItem('engram.interviewPending', '1') })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const engines = [{ id: 'claude', installed: true, loggedIn: true, healthy: true }]
    ipcMain.removeHandler('engines:list'); ipcMain.handle('engines:list', () => engines)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:changed', engines })
  })
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('engines:isDetected'); ipcMain.handle('engines:isDetected', () => true)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  })
  await expect(page.getByTestId('interview-start-now')).toBeVisible()
  await expect(page.getByTestId('interview-start')).toHaveCount(0)
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(1)
  const cancels = await app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupCanceled)
  await page.getByTestId('interview-start-now').click()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupCanceled)).toBeGreaterThan(cancels)
  expect(await page.evaluate(() => localStorage.getItem('engram.interviewPending'))).toBeNull()
  await progress(0, 'questions')
  await app.evaluate((_electron, questions) => (globalThis as typeof globalThis & Fixture).setupRequests[0]!.resolve(questions), QUESTIONS)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('engram.interviewPending', '1'))
  await page.reload()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & Fixture).setupRequests.length)).toBe(2)
  await app.evaluate((_electron, questions) => (globalThis as typeof globalThis & Fixture).setupRequests[1]!.resolve(questions), QUESTIONS)
  await page.getByTestId('interview-dialog').getByRole('checkbox').first().check()
  await page.getByTestId('interview-next').click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('engram.interviewPending'))).toBeNull()
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
})
