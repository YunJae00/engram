import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const PREVIEW = join(TMP, 'work-interview-compact-preview')
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
  const leftAligned = await page.locator('.interview-intro').evaluate(el => {
    const bounds = el.getBoundingClientRect()
    return [...el.children].every(child => Math.abs(child.getBoundingClientRect().x - bounds.x) <= 1)
  })
  expect(leftAligned).toBe(true)
  await expect(page.locator('.interview-intro').getByRole('heading')).toHaveCSS('text-align', 'left')
  await screenshot('01-intro-light-960.png')
  await page.getByTestId('interview-start').click()
  await expect(page.getByRole('status').filter({ hasText: 'Preparing questions' })).toBeVisible()
  await expect(page.getByTestId('interview-question-0')).toBeVisible()
  await expect(page.getByTestId('interview-progress')).toContainText('1 / 2')
  await expect(page.getByTestId('interview-dialog').getByText('How you work', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Choose any that fit.', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('interview-later')).toHaveCount(0)
  await expect(page.locator('.interview-basis')).toHaveCount(0)
  await expect(page.getByText(QUESTIONS[0].basis, { exact: false })).toHaveCount(0)
  await expect(page.getByTestId('interview-question-0').getByRole('heading')).toHaveCSS('font-size', '18px')
  await expect(page.getByTestId('interview-question-0').getByRole('heading')).toHaveCSS('text-align', 'left')
  await expect(page.locator('.interview-option').first()).toHaveCSS('text-align', 'left')
  const close = await page.getByRole('button', { name: 'Close work interview' }).boundingBox()
  const question = await page.getByTestId('interview-question-0').boundingBox()
  expect(Math.abs(close!.x + close!.width - question!.x - question!.width)).toBeLessThanOrEqual(1)
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
  await expect(page.locator('.interview-review').getByRole('heading')).toHaveCSS('text-align', 'left')
  await screenshot('04-review-dark-600.png')
  await page.getByRole('button', { name: 'Edit answer 1' }).click()
  await page.getByTestId('interview-answer-0').fill('Keep the original customer IDs.')
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('alert')).toContainText('They are still here')
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key) { if (key === 'engram.interviewPending') throw new Error('Fixture storage unavailable'); remove.call(this, key) }
  })
  await page.getByTestId('interview-save').click()
  await expect(page.getByTestId('interview-dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  await expect(page.locator('.interview-success')).toHaveCSS('justify-items', 'center')
  await expect(page.locator('.interview-success').getByRole('heading')).toHaveCSS('text-align', 'center')
  await expect(page.getByTestId('interview-done')).toBeVisible()
  await expect(page.getByTestId('interview-save')).toHaveCount(0)
  await screenshot('05-saved-dark-600.png')
  await page.getByTestId('interview-done').click()
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { interviewSaves: number }).interviewSaves)).toBe(2)
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
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('interview:save'); ipcMain.handle('interview:save', () => ({ saved: true })) })
  await page.evaluate(() => localStorage.setItem('engram.interviewPending', '1'))
  await page.reload()
  await page.getByTestId('interview-start').click()
  await page.getByTestId('interview-dialog').getByRole('checkbox').first().check()
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('engram.interviewPending'))).toBeNull()
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('interview-dialog')).toHaveCount(0)
})

test('long questions keep progress and actions fixed above a scrolling body', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('interview:questions')
    ipcMain.handle('interview:questions', () => [{ topic: 'rules',
      question: 'When a client update includes conflicting source information and several departments need to review the same deliverable, how should Engram prepare a draft that preserves the original identifiers, makes uncertainty clear, and leaves the final decision with you?',
      basis: 'Documents/Client project handover/Weekly review checklist and project.example.com',
      options: Array.from({ length: 5 }, (_, i) => `${i + 1}. Keep the original project names and source identifiers; separate confirmed facts from assumptions and include a link to the supporting document.`),
    }])
  })
  await page.setViewportSize({ width: 600, height: 520 })
  await openInterview()
  await page.getByTestId('interview-start').click()
  await expect(page.getByTestId('interview-question-0')).toBeVisible()
  const dialog = page.getByTestId('interview-dialog')
  const progress = page.getByTestId('interview-progress')
  const scroll = page.getByTestId('interview-scroll')
  const next = page.getByTestId('interview-next')
  const origin = { progress: await progress.boundingBox(), next: await next.boundingBox() }
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  const boxes = await dialog.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => {
    const box = input.getBoundingClientRect(), row = input.closest('label')!.getBoundingClientRect(), style = getComputedStyle(input)
    return { width: box.width, height: box.height, opacity: Number(style.opacity), centered: Math.abs(box.y + box.height / 2 - row.y - row.height / 2), right: box.x > row.x + row.width / 2 }
  }))
  for (const box of boxes) {
    expect(box.width).toBe(16); expect(box.height).toBe(16)
    expect(box.opacity).toBeGreaterThan(0); expect(box.centered).toBeLessThanOrEqual(1)
    expect(box.right).toBe(true)
  }
  await dialog.getByRole('checkbox').first().check()
  await expect(dialog.getByRole('checkbox').first()).toBeChecked()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await scroll.evaluate(el => { el.scrollTop = 0 })
    await screenshot(`06-long-question-${theme}-600x520-top.png`)
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect.poll(() => progress.boundingBox().then(box => Math.abs(box!.y - origin.progress!.y))).toBeLessThanOrEqual(1)
    await expect.poll(() => next.boundingBox().then(box => Math.abs(box!.y - origin.next!.y))).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('interview-answer-0')).toBeVisible()
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await screenshot(`07-long-question-${theme}-600x520-bottom.png`)
  }
  await next.click()
  await expect(page.getByTestId('interview-save')).toBeEnabled()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0)
  await dialog.getByRole('checkbox').first().uncheck()
  await next.click()
  await expect(page.getByTestId('interview-save')).toBeDisabled()
})

test('question changes animate briefly and honor reduced motion', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    const state = window as typeof window & { interviewAnimations: string[] }
    state.interviewAnimations = []
    document.addEventListener('animationstart', event => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('[data-testid="work-interview"]')) state.interviewAnimations.push(getComputedStyle(target).animationDuration)
    })
  })
  const clear = () => page.evaluate(() => { (window as typeof window & { interviewAnimations: string[] }).interviewAnimations = [] })
  const durations = () => page.evaluate(() => (window as typeof window & { interviewAnimations: string[] }).interviewAnimations)
  await openInterview()
  await page.getByTestId('interview-start').click()
  await expect(page.getByTestId('interview-question-0')).toBeVisible()
  await expect.poll(durations).toContain('0.18s')
  await clear()
  await page.getByTestId('interview-next').click()
  await expect.poll(durations).toContain('0.18s')
  await clear()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect.poll(durations).toContain('0.18s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.interview-option').first()).toHaveCSS('transition-duration', '0s')
  await clear()
  await page.getByTestId('interview-next').click()
  await expect(page.getByTestId('interview-question-1')).toBeVisible()
  await page.waitForTimeout(220)
  expect(await durations()).not.toContain('0.18s')
})

test('preparation shows elapsed time, an honest slow hint, and a working cancel action', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('interview:questions')
    ipcMain.handle('interview:questions', async () => {
      await new Promise<void>(resolve => { (globalThis as typeof globalThis & { releaseInterview: () => void }).releaseInterview = resolve })
      return []
    })
  })
  await page.setViewportSize({ width: 600, height: 520 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await openInterview()
  await page.clock.install()
  await page.getByTestId('interview-start').click()
  const wait = page.locator('.interview-wait')
  await expect(wait).toBeVisible()
  await expect(wait).toContainText('Preparing questions')
  await expect(wait).toHaveCSS('justify-items', 'center')
  await expect(wait.getByRole('heading')).toHaveCSS('text-align', 'center')
  await expect(wait.getByRole('progressbar')).toHaveCount(0)
  await expect(page.getByTestId('interview-start')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your way of working' })).toHaveCount(0)
  await screenshot('08-loading-light-600x520.png')
  await expect(wait).toContainText('This can take a minute or more.')
  await page.clock.runFor(21_000)
  await expect(wait).toContainText('Still waiting for your AI')
  await expect(wait.getByRole('timer')).toHaveText(/0:2\d/)
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await screenshot('09-loading-slow-dark-600x520.png')
  await wait.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('interview-start')).toBeVisible()
  await app.evaluate(() => (globalThis as typeof globalThis & { releaseInterview: () => void }).releaseInterview())
  await expect(wait).toHaveCount(0)
})

test('a completed save replaces an open leave confirmation with the saved screen', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('interview:save')
    ipcMain.handle('interview:save', async () => {
      await new Promise<void>(resolve => { (globalThis as typeof globalThis & { releaseInterviewSave: () => void }).releaseInterviewSave = resolve })
      return { saved: true }
    })
  })
  await page.setViewportSize({ width: 600, height: 800 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await openInterview()
  await page.getByTestId('interview-start').click()
  await page.getByTestId('interview-dialog').getByRole('checkbox').first().check()
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByTestId('interview-wait')).toContainText('Saving your preferences')
  await page.getByRole('button', { name: 'Close work interview', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Leave without saving?' })).toBeVisible()
  await screenshot('10-leave-during-save-light-600.png')
  await app.evaluate(() => (globalThis as typeof globalThis & { releaseInterviewSave: () => void }).releaseInterviewSave())
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Discard answers', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('interview-done')).toBeFocused()
  await screenshot('11-saved-after-close-light-600.png')
  await page.getByTestId('interview-done').click()
  await expect(page.getByTestId('interview-dialog')).toBeHidden()
})

test('saving shows elapsed time and keeps drafts through cancellation, errors and late replies', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('interview:save')
    const state = globalThis as typeof globalThis & { interviewSaves: number; interviewSaveReleases: Array<() => void> }
    state.interviewSaveReleases = []
    ipcMain.handle('interview:save', async () => {
      if (++state.interviewSaves === 2) throw new Error('Fixture retry failure')
      await new Promise<void>(resolve => state.interviewSaveReleases.push(resolve))
      return { saved: true }
    })
  })
  await page.setViewportSize({ width: 600, height: 520 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await openInterview()
  await page.getByTestId('interview-start').click()
  await page.getByTestId('interview-answer-0').fill('Keep the original project names.')
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.clock.install()
  await page.getByTestId('interview-save').click()
  const wait = page.getByTestId('interview-wait')
  await expect(wait.getByRole('heading')).toHaveText('Saving your preferences…')
  await expect(wait).toHaveCSS('justify-items', 'center')
  await expect(wait.getByRole('heading')).toHaveCSS('text-align', 'center')
  await expect(wait.getByRole('heading')).toBeFocused()
  await expect(wait).toContainText('This can take a minute or more.')
  await expect(page.getByTestId('interview-progress')).toHaveCount(0)
  await expect(page.getByTestId('interview-save')).toHaveCount(0)
  await screenshot('12-saving-light-600x520.png')
  await page.clock.runFor(21_000)
  await expect(wait).toContainText('Still waiting for your AI')
  await expect(wait.getByRole('timer')).toHaveText(/0:2\d/)
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await screenshot('13-saving-slow-dark-600x520.png')
  await wait.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit answer 1' })).toContainText('Keep the original project names.')
  await page.getByRole('button', { name: 'Edit answer 1' }).click()
  await page.getByTestId('interview-answer-0').fill('Keep this updated draft.')
  await page.getByTestId('interview-next').click()
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByTestId('interview-save').click()
  await expect(page.getByRole('alert')).toContainText('They are still here')
  await expect(page.getByRole('button', { name: 'Edit answer 1' })).toContainText('Keep this updated draft.')
  await page.getByTestId('interview-save').click()
  await expect(wait.getByRole('timer')).toHaveText('0:00')
  await app.evaluate(() => (globalThis as typeof globalThis & { interviewSaveReleases: Array<() => void> }).interviewSaveReleases[0]!())
  await page.clock.runFor(250)
  await expect(wait).toBeVisible()
  await expect(page.getByTestId('interview-done')).toHaveCount(0)
  await app.evaluate(() => (globalThis as typeof globalThis & { interviewSaveReleases: Array<() => void> }).interviewSaveReleases[1]!())
  await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
  await expect(page.getByTestId('interview-done')).toBeFocused()
})
