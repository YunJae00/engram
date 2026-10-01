import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { initVault } from 'core'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('workspace deletion is cancellable and restarts the last workspace into onboarding', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const fixture = await mkdtemp(join(tmp, 'e2e-delete-'))
  const root = join(fixture, 'vault'), userData = join(fixture, 'profile')
  await initVault(root, { git: false })
  await mkdir(userData)
  await writeFile(join(userData, 'vaults.json'), JSON.stringify({ current: 'test', vaults: [{ id: 'test', name: 'Test workspace', root, kind: 'personal', createdAt: new Date().toISOString() }] }))
  const launch = () => electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: userData, ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' } })
  let app: ElectronApplication | undefined = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await page.getByTestId('workspace-switcher').click()
    await page.locator('.workspace-management > summary').click()
    const remove = page.getByRole('button', { name: 'Delete workspace Test workspace', exact: true })
    await expect(remove).toBeVisible()
    await remove.click()
    await expect(remove).toBeEnabled()
    await access(root)
    expect(JSON.parse(await readFile(join(userData, 'vaults.json'), 'utf8')).pendingDelete).toBeUndefined()
    await app.evaluate(({ app, dialog }) => {
      app.relaunch = () => undefined // The test owns the next process, never a detached relaunch.
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await Promise.all([app.waitForEvent('close'), remove.click()])
    app = undefined
    await access(root) // Recycled only on the next boot, after old writers have exited.
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('onboarding')).toBeVisible()
    await expect(page.getByTestId('onboard-step-1')).toBeVisible()
    await expect(access(root)).rejects.toThrow()
    expect(JSON.parse(await readFile(join(userData, 'vaults.json'), 'utf8'))).toEqual({ current: null, vaults: [] })
  } finally { await app?.close() }
})
