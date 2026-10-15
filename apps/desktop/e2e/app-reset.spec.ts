import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { initVault } from 'core'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test('reset confirmation erases local app data and returns to first setup without touching sign-ins or original files', async () => {
  test.setTimeout(300_000)
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const fixture = await mkdtemp(join(tmp, 'e2e-reset-')), root = join(fixture, 'vault'), userData = join(fixture, 'profile')
  await initVault(root, { git: false })
  await mkdir(userData)
  await writeFile(join(userData, 'vaults.json'), JSON.stringify({ current: 'test', vaults: [{ id: 'test', name: 'Test workspace', root, kind: 'personal', createdAt: new Date().toISOString() }] }))
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', workMap: true }))
  await mkdir(join(userData, 'account-profiles'))
  await writeFile(join(userData, 'account-profiles', 'keep.txt'), 'Retained account fixture')
  await writeFile(join(fixture, 'original.txt'), 'Original document')
  const launch = async (selfRestart = false) => {
    const running = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: userData, ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' } })
    if (selfRestart) await running.evaluate(({ app }) => {
      // A self-initiated restart must not wait for the test debugger to disconnect.
      const inspector = process.getBuiltinModule('inspector') as typeof import('node:inspector')
      app.prependOnceListener('will-quit', () => inspector.close())
    })
    return running
  }
  let app: ElectronApplication | undefined = await launch(true)
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.evaluate(() => localStorage.setItem('reset-fixture', 'old'))
    await app.evaluate(async ({ app, dialog, session }) => {
      app.relaunch = () => undefined
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      await session.defaultSession.cookies.set({ url: 'https://reset-fixture.invalid', name: 'retained-login', value: 'fixture', expirationDate: Date.now() / 1000 + 86400 })
      await session.defaultSession.cookies.flushStore()
    })
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-memory').click()
    const button = page.getByTestId('settings-reset')
    await button.click()
    await expect(button).toBeEnabled()
    await access(root)
    await expect(access(join(userData, 'reset-request.json'))).rejects.toThrow()
    await page.screenshot({ path: join(tmp, 'settings-reset.png') })
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    const oldProcess = app.process()
    await Promise.all([expect.poll(() => oldProcess.exitCode, { timeout: 30_000 }).not.toBeNull(), button.click()])
    app = undefined
    await access(root)
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('onboard-step-1')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('reset-fixture'))).toBeNull()
    expect(await page.evaluate(() => window.engram.settingsGet().then(settings => ({ theme: settings.theme, workMap: settings.workMap })))).toEqual({ theme: 'system', workMap: false })
    for (const path of [root, join(userData, 'vaults.json'), join(userData, 'reset-request.json')]) await expect(access(path)).rejects.toThrow()
    expect(await readFile(join(fixture, 'original.txt'), 'utf8')).toBe('Original document')
    expect(await readFile(join(userData, 'account-profiles', 'keep.txt'), 'utf8')).toBe('Retained account fixture')
    expect(await app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: 'retained-login' }).then(cookies => cookies.length))).toBe(1)
  } finally {
    if (app) {
      const process = app.process()
      if (process.exitCode === null) await app.close()
      await expect.poll(() => process.exitCode, { timeout: 30_000 }).not.toBeNull()
    }
  }
})
