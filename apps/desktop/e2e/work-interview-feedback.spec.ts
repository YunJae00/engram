import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const PREVIEW = join(TMP, 'work-interview-relevant-preview')
const QUESTIONS = [
  { topic: 'outputs', question: 'How do you share a project update?', basis: '', source: 'place-0123456789abcdef01234567', options: ['Prepare a short draft.', 'Link to the source.'] },
  { topic: 'rules', question: 'When should I pause and ask you?', basis: '', source: 'task-0123456789abcdef01234567', options: ['Before sending.', 'When sources disagree.'] },
]
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  await mkdir(PREVIEW, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-interview-feedback-'))
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
    ipcMain.handle('interview:questions', () => questions)
    ipcMain.handle('interview:save', (_event, answers) => {
      (globalThis as typeof globalThis & { interviewSaved: unknown }).interviewSaved = answers
      return { saved: true }
    })
    ipcMain.handle('interview:cancel', () => undefined)
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

test('the compact introduction keeps privacy details accessible in narrow light and dark windows', async () => {
  await page.setViewportSize({ width: 600, height: 800 })
  await openInterview()
  const dialog = page.getByTestId('interview-dialog')
  const details = page.locator('.interview-privacy')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect(details.locator('p')).toBeHidden()
    await expect(page.getByTestId('interview-intro-heading')).toHaveCSS('text-align', 'left')
    const height = (await dialog.boundingBox())!.height
    expect(height).toBeLessThan(300)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await screenshot(`intro-${theme}-600.png`)
    await details.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(details.locator('p')).toContainText('Site names and visit patterns, completed task requests, and your work guide. No file contents.')
    await screenshot(`privacy-${theme}-600.png`)
    await page.keyboard.press('Enter')
  }
})

test('no relevant questions finish calmly without an error or a forced retry', async () => {
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('interview:questions'); ipcMain.handle('interview:questions', () => []) })
  await openInterview()
  await page.evaluate(() => localStorage.setItem('engram.interviewPending', '1'))
  await page.getByTestId('interview-start').click()
  await expect(page.getByRole('heading', { name: 'Nothing to ask yet' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('interview-start')).toHaveCount(0)
  await expect(page.getByTestId('interview-progress')).toHaveCount(0)
  await expect(page.getByTestId('interview-done')).toBeFocused()
  expect(await page.evaluate(() => localStorage.getItem('engram.interviewPending'))).toBeNull()
  await screenshot('nothing-to-ask.png')
  await page.getByTestId('interview-done').click()
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
})

test('not-my-work feedback clears an answer, can be undone and saves without other answers', async () => {
  await page.setViewportSize({ width: 600, height: 800 })
  await openInterview()
  await page.getByTestId('interview-start').click()
  const choices = page.getByTestId('interview-dialog').getByRole('checkbox')
  const reject = page.getByTestId('interview-not-mine')
  await choices.first().check()
  await page.getByTestId('interview-answer-0').fill('Old answer')
  await reject.click()
  await expect(page.getByTestId('interview-question-1')).toBeVisible()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit answer 1' })).toContainText('Not my work')
  await expect(page.getByRole('button', { name: 'Edit answer 2' })).toContainText('Skipped')
  await expect(page.getByTestId('interview-save')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Leave without saving?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep answering' }).click()
  await page.getByRole('button', { name: 'Edit answer 1' }).click()
  await expect(choices.first()).not.toBeChecked()
  await expect(page.getByTestId('interview-answer-0')).toHaveValue('')
  await expect(reject).toHaveAttribute('aria-pressed', 'true')
  await choices.first().check()
  await expect(reject).toHaveAttribute('aria-pressed', 'false')
  await reject.click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByTestId('interview-answer-0').fill('Updated answer')
  await expect(reject).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit answer 1' })).toContainText('Updated answer')
  await page.getByRole('button', { name: 'Edit answer 1' }).click()
  await screenshot('feedback-question-light-600.png')
  await reject.click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await screenshot('feedback-review-light-600.png')
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { interviewSaved: unknown }).interviewSaved)).toEqual([
    { question: QUESTIONS[0]!.question, answer: '', source: QUESTIONS[0]!.source, rejected: true },
    { question: QUESTIONS[1]!.question, answer: '', source: QUESTIONS[1]!.source },
  ])
})
