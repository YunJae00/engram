import { expect, type ElectronApplication, type Page } from '@playwright/test'
import type { DevelopersApi, DevUpdate } from '../src/shared/developers.js'

export async function renderTaskFixture({ app, page, screenshot }: { app: ElectronApplication; page: Page; screenshot(name: string): Promise<void> }) {
  await page.setViewportSize({ width: 1360, height: 900 })
  await page.getByRole('button', { name: 'Developers mode', exact: true }).click()
  const id = await page.evaluate(async () => {
    const api = (window as unknown as { engram: DevelopersApi }).engram, state = await api.devState()
    return (await api.devCreate({ repoId: state.repos[0]!.id, provider: 'codex', model: '', mode: 'review', isolate: false })).id
  })
  await page.locator('.dev-task-link').filter({ hasText: 'New task' }).click()
  await expect(page.getByRole('textbox', { name: 'Development message' })).toBeEnabled()
  const update: DevUpdate = { id, state: 'waiting', runtimeId: 'fixture', usage: { input: 1200, output: 240 }, items: [
    { id: 'request', kind: 'user', text: 'Fix the off-by-one error and add a focused check.' },
    { id: 'command', kind: 'tool', title: 'Command', activity: 'command', text: 'pnpm test\nAll checks passed', status: 'done' },
    { id: 'edit', kind: 'tool', title: 'Edit · example.ts', activity: 'file', text: 'example.ts\n- return items.slice(0, limit + 1)\n+ return items.slice(0, limit)', status: 'running' },
    { id: 'response', kind: 'assistant', text: 'The boundary includes one extra item. The proposed change is:\n\n```ts\nreturn items.slice(0, limit)\n```\n\n| Check | Result |\n| --- | --- |\n| Boundary | Fixed |\n\n1. Preserve the public API.\n2. Add a regression check.' },
  ], pending: [{ id: 'question', kind: 'question', title: 'Your input is needed', detail: '', questions: [{ id: 'scope', text: 'How should a zero limit behave?', options: ['Return an empty list', 'Use the default limit'] }] }] }
  await app.evaluate(({ BrowserWindow }, update) => { BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'dev:changed', update }) }, update)
  await expect(page.locator('.dev-message pre code')).toHaveText('return items.slice(0, limit)')
  await expect(page.locator('.dev-message table')).toContainText('Boundary')
  await expect(page.locator('.dev-message ol > li')).toHaveCount(2)
  const reading = await page.locator('.dev-log').evaluate(log => {
    const style = getComputedStyle(log), composer = log.parentElement!.querySelector('.dev-composer')!.getBoundingClientRect()
    return { width: log.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), composer: composer.width, overflow: log.scrollWidth > log.clientWidth }
  })
  expect(reading.width).toBeLessThanOrEqual(740)
  expect(reading.composer - reading.width).toBeGreaterThanOrEqual(32)
  expect(reading.overflow).toBe(false)
  await expect(page.locator('.dev-tool').first()).toContainText('Done')
  await page.locator('.dev-tool').first().locator('summary').click()
  await expect(page.locator('.dev-tool').first().locator('pre')).toBeVisible()
  await expect(page.locator('.dev-tool').last()).toContainText('Running')
  await page.getByLabel('Return an empty list', { exact: true }).check()
  await page.getByRole('button', { name: 'Session options', exact: true }).click()
  await expect(page.getByText('Usage and limits', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Project files', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await screenshot('developers-task-light.png')
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark' })
  await screenshot('developers-task-dark.png')
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'light' })
  await app.evaluate(({ BrowserWindow, ipcMain }, id) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'dev:changed', update: { id, state: 'idle', items: [], pending: [], usage: {} } })
    ipcMain.removeHandler('devFork')
    ipcMain.handle('devFork', (_event, _id, isolate) => { if (isolate !== true) throw new Error('Wrong branch option'); throw new Error('A separate worktree needs a Git repository with at least one commit. Choose “Same folder” to branch only the conversation. No files were changed.') })
  }, id)
  await page.getByRole('button', { name: 'Branch session', exact: true }).click()
  await expect(page.getByRole('button', { name: /Same folder/ })).toBeVisible()
  await screenshot('developers-branch-options.png')
  await page.getByRole('button', { name: /Separate worktree.*Isolated files/ }).click()
  await expect(page.getByRole('alert')).toContainText('needs a Git repository')
  await expect(page.getByRole('alert')).not.toContainText('Error invoking remote method')
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await page.setViewportSize({ width: 950, height: 900 })
  const narrow = await page.locator('.dev-log').evaluate(log => {
    const style = getComputedStyle(log), composer = log.parentElement!.querySelector('.dev-composer')!.getBoundingClientRect()
    return { width: log.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), composer: composer.width, overflow: log.scrollWidth > log.clientWidth }
  })
  expect(narrow.composer - narrow.width).toBeGreaterThanOrEqual(32)
  expect(narrow.overflow).toBe(false)
  await screenshot('developers-reading-narrow.png')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('devGit'); ipcMain.handle('devGit', () => ({ scope: 'task', branch: 'Since this task started', files: [{ path: 'example.ts', status: ' M' }], diff: '', truncated: false, warning: 'Existing uncommitted edits are included in the starting files.' }))
    ipcMain.removeHandler('devFileReview'); ipcMain.handle('devFileReview', () => ({ scope: 'task', path: 'example.ts', before: 'user draft', after: 'agent change', fingerprint: 'fixture', readOnly: false, hunks: [{ index: 0, line: 1, text: '-user draft\n+agent change' }] }))
  })
  await page.getByRole('button', { name: 'Changes', exact: true }).click()
  const review = page.getByRole('complementary', { name: 'Working tree changes' })
  await expect(review).toContainText('Task changes')
  await expect(review.getByRole('button', { name: 'Stage selected' })).toHaveCount(0)
  await review.getByRole('button', { name: 'example.ts', exact: true }).click()
  await expect(review).toContainText('Pre-existing edits are preserved')
  await expect(review.getByRole('button', { name: 'Discard this hunk' })).toBeEnabled()
  await screenshot('developers-task-review.png')
  await review.getByRole('button', { name: 'Close changes' }).click()
}
