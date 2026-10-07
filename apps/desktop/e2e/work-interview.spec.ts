import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const PREVIEW = join(TMP, 'work-interview-preview')
const QUESTIONS = [
  { topic: 'outputs', question: 'What makes a weekly client update ready to share?', basis: 'Documents/Client updates and project.example.com', options: ['Keep the summary short and link to the detailed report.', 'Use the original project names and identifiers.', 'Separate confirmed facts from assumptions.', 'List risks with a clear owner and next step.', 'Prepare a draft for my approval before sending.'] },
  { topic: 'rules', question: 'When should Engram pause and ask you?', basis: 'Documents/Approval checklist', options: ['Before sending anything outside the team.', 'When the source information conflicts.'] },
] as const
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  await mkdir(PREVIEW, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-interview-'))
  await initVault(join(root, 'vault'), { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: join(root, 'vault'), ENGRAM_USERDATA: join(root, 'profile'),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }, questions) => {
    for (const channel of ['interview:questions', 'interview:save', 'interview:cancel']) ipcMain.removeHandler(channel)
    const state = globalThis as typeof globalThis & { interviewSaved: unknown; interviewCanceled: number; interviewSaves: number }
    state.interviewCanceled = 0; state.interviewSaves = 0
    ipcMain.handle('interview:questions', async () => { await new Promise(resolve => setTimeout(resolve, 600)); return questions })
    ipcMain.handle('interview:save', (_event, answers) => {
      if (++state.interviewSaves === 1) throw new Error('Fixture save failure')
      state.interviewSaved = answers; return { saved: true }
    })
    ipcMain.handle('interview:cancel', () => { state.interviewCanceled++ })
  }, QUESTIONS)
})
test.afterEach(async () => { await app?.close() })

async function openInterview() {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-memory').click()
  await page.getByTestId('interview-open').click()
  await expect(page.getByTestId('interview-dialog')).toBeVisible()
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

test('questions are optional, editable and usable in narrow light and dark windows', async () => {
  await page.setViewportSize({ width: 960, height: 720 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await openInterview()
  await screenshot('01-intro-light-960.png')
  await page.getByTestId('interview-start').click()
  await expect(page.getByRole('status').filter({ hasText: 'Preparing questions' })).toBeVisible()
  await expect(page.getByTestId('interview-question-0')).toBeVisible()
  const choices = page.getByTestId('interview-dialog').getByRole('checkbox')
  await choices.nth(0).focus(); await page.keyboard.press('Space')
  await choices.nth(1).check()
  await page.getByTestId('interview-answer-0').fill('Keep the source terminology unchanged.')
  await screenshot('02-question-light-960.png')
  await page.setViewportSize({ width: 600, height: 800 })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect.poll(() => page.getByTestId('interview-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const next = await page.getByTestId('interview-next').boundingBox()
    expect(next!.y + next!.height).toBeLessThan(800)
    await screenshot(`03-question-${theme}-600.png`)
  }
  await page.getByTestId('interview-next').click()
  await expect(page.getByTestId('interview-question-1').getByRole('heading')).toBeFocused()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(choices.nth(0)).toBeChecked()
  await expect(page.getByTestId('interview-answer-0')).toHaveValue('Keep the source terminology unchanged.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Leave without saving?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep answering' })).toBeFocused()
  await page.getByRole('button', { name: 'Keep answering' }).click()
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit answer 2' })).toContainText('Skipped')
  await screenshot('04-review-dark-600.png')
  await page.getByRole('button', { name: 'Edit answer 1' }).click()
  await page.getByTestId('interview-answer-0').fill('Keep the original customer IDs.')
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('alert')).toContainText('They are still here')
  await page.getByTestId('interview-save').click()
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { interviewSaved: unknown }).interviewSaved)).toEqual([
    { question: QUESTIONS[0].question, answer: `${QUESTIONS[0].options[0]}; ${QUESTIONS[0].options[1]}; Keep the original customer IDs.` },
    { question: QUESTIONS[1].question, answer: '' },
  ])
})

test('empty responses can retry and canceled requests cannot replace a newer screen', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('interview:questions')
    let calls = 0
    ipcMain.handle('interview:questions', async () => {
      if (++calls === 1) return []
      if (calls === 2) throw new Error('Fixture offline')
      await new Promise<void>(resolve => { (globalThis as typeof globalThis & { releaseInterview: () => void }).releaseInterview = resolve })
      return [{ question: 'Stale question', basis: '', options: [], topic: 'rules' }]
    })
  })
  await openInterview()
  await page.getByTestId('interview-start').click()
  await expect(page.getByRole('alert')).toContainText('No questions yet')
  await page.getByTestId('interview-start').click()
  await expect(page.getByRole('alert')).toContainText('Check your AI connection')
  await page.getByTestId('interview-start').click()
  await page.getByTestId('interview-dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('interview-start')).toBeVisible()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { interviewCanceled: number }).interviewCanceled)).toBeGreaterThan(0)
  await app.evaluate(() => (globalThis as typeof globalThis & { releaseInterview: () => void }).releaseInterview())
  await page.waitForTimeout(250)
  await expect(page.getByText('Stale question', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
  await expect(page.getByTestId('interview-open')).toBeFocused()
})

test('first-run entry opens once without trapping someone who wants to start work', async () => {
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('app:tourEligible'); ipcMain.handle('app:tourEligible', () => true) })
  await page.evaluate(() => { localStorage.setItem('engram.tour.done', '1'); localStorage.setItem('engram.interviewPending', '1') })
  await page.reload()
  await expect(page.getByTestId('interview-dialog')).toBeVisible()
  await expect(page.getByTestId('interview-start')).toBeVisible()
  await page.getByTestId('interview-later').click()
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('engram.interviewPending'))).toBeNull()
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
})
