import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Context { app: ElectronApplication; page: Page; project: string; screenshot(name: string): Promise<void> }
export async function filesFixture({ page, project, screenshot }: Context) {
  await page.setViewportSize({ width: 1360, height: 900 })
  const pane = page.locator('.dev-pane').first()
  await pane.getByRole('button', { name: 'Session options', exact: true }).click()
  await page.getByRole('button', { name: 'Project files', exact: true }).click()
  const files = page.getByRole('complementary', { name: 'Project files' })
  await files.getByRole('button', { name: 'example.ts', exact: true }).click()
  await expect(files.locator('.cm-content')).toContainText('export const answer = 42')
  await files.locator('.cm-content').fill('export const answer = 43')
  await files.getByRole('button', { name: 'Save file', exact: true }).click()
  await expect(files.getByRole('status')).toContainText('Saved')
  await files.locator('.cm-content').fill('export const answer = 44')
  await writeFile(join(project, 'example.ts'), 'export const answer = 45\n')
  await files.getByRole('button', { name: 'Save file', exact: true }).click()
  await expect(files.getByRole('alert')).toContainText('changed on disk')
  await expect(files.locator('.cm-content')).toContainText('answer = 44')
  await screenshot('developers-files-conflict.png')
  await files.getByRole('button', { name: 'Close project files' }).click()
  await pane.getByRole('button', { name: 'Session options', exact: true }).click()
  await page.getByRole('button', { name: 'Project files', exact: true }).click()
  await files.getByRole('button', { name: 'example.ts', exact: true }).click()
  await expect(files.locator('.cm-content')).toContainText('answer = 44')
  await files.getByRole('button', { name: 'Save file', exact: true }).click()
  await expect(files.getByRole('alert')).toContainText('changed on disk')
  await files.getByRole('button', { name: 'Discard draft and reload' }).click()
  await expect(files.locator('.cm-content')).toContainText('answer = 45')
  await files.locator('summary').filter({ hasText: 'New file' }).click()
  await files.getByLabel('New filename').fill('new.ts')
  await files.getByRole('button', { name: 'Create file', exact: true }).click()
  await expect(files.locator('.dev-file-title')).toContainText('new.ts')
  await files.locator('.cm-content').fill('const shape = { result: 1 }; shape.')
  await files.locator('.cm-content').press('Control+End')
  await files.locator('.cm-content').press('Control+Space')
  await files.locator('.dev-language-results button').filter({ hasText: 'result' }).click()
  await expect(files.locator('.cm-content')).toContainText('shape.result')
  await files.locator('.cm-content').fill('const amount: number = "wrong"')
  await files.getByRole('button', { name: 'Check code', exact: true }).click()
  await expect(files.locator('.dev-language-results')).toContainText('not assignable')
  await screenshot('developers-language.png')
  await files.getByRole('button', { name: 'Discard draft and reload' }).click()
  await files.locator('summary').filter({ hasText: 'Search project' }).click()
  await files.getByLabel('Search project text or filenames').fill('answer')
  await files.getByRole('button', { name: 'Search', exact: true }).click()
  await files.getByRole('button', { name: /example.ts:1/ }).click()
  await expect(files.locator('.cm-content')).toContainText('answer = 45')
  await files.getByRole('button', { name: 'Attach file', exact: true }).click()
  await expect(pane.getByRole('textbox', { name: 'Development message' })).toHaveValue(/Context from "example.ts"[\s\S]*answer = 45/)
  await pane.getByRole('textbox', { name: 'Development message' }).fill('')
}

export async function consoleFixture({ app, page, screenshot }: Context) {
  const pane = page.locator('.dev-pane').first()
  await pane.getByRole('button', { name: 'Session options', exact: true }).click()
  await page.getByRole('button', { name: 'Command console', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Command console' })
  await app.evaluate(({ dialog }) => {
    const fixture = globalThis as unknown as { restoreDevDialog?: typeof dialog.showMessageBox }
    fixture.restoreDevDialog = dialog.showMessageBox
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  try {
    const command = process.platform === 'win32' ? 'Write-Output "fixture console"; Start-Sleep -Seconds 30' : 'printf "fixture console"; sleep 30'
    await panel.getByLabel('Workspace command').fill(command)
    await panel.getByRole('button', { name: 'Run command…', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('Nothing was executed')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await panel.getByRole('button', { name: 'Run command…', exact: true }).click()
    await expect(panel.getByLabel('Command output')).toContainText('fixture console')
    await panel.getByRole('button', { name: 'Close command console' }).click()
    await pane.getByRole('button', { name: 'Session options', exact: true }).click()
    await page.getByRole('button', { name: 'Command console', exact: true }).click()
    await expect(panel.getByLabel('Command output')).toContainText('fixture console')
    await panel.getByRole('button', { name: 'Stop command', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText('Stopped')
    await expect(panel.getByText('Saved locally:', { exact: false })).toBeVisible()
    await screenshot('developers-console.png')
    await panel.getByRole('button', { name: 'Close command console' }).click()
  } finally {
    await app.evaluate(({ dialog }) => {
      const fixture = globalThis as unknown as { restoreDevDialog?: typeof dialog.showMessageBox }
      if (fixture.restoreDevDialog) dialog.showMessageBox = fixture.restoreDevDialog
      delete fixture.restoreDevDialog
    })
  }
}
