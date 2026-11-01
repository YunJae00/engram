import { test, expect, _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

test('packaged app opens an isolated vault and reports native access honestly', async () => {
  const executablePath = process.env.ENGRAM_PACKAGED_APP
  test.skip(!executablePath, 'Requires an explicitly selected packaged executable')
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const run = await mkdtemp(join(root, 'packaged-smoke-'))
  const paths = await initVault(join(run, 'vault'), { git: false })
  const app = await electron.launch({ executablePath, env: { ...process.env, ENGRAM_VAULT: paths.root,
    ENGRAM_USERDATA: join(run, 'profile'), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }))
    expect(metadata.packaged).toBe(true)
    await page.screenshot({ path: join(run, 'app.png') })
    const native = await page.evaluate(async () => {
      try { const windows = await window.engram.desktopWindows(); return { available: windows.length > 0, windowCount: windows.length, ...(windows.length ? {} : { error: 'No accessible app windows were returned; native control is unverified.' }) } }
      catch (error) { return { available: false, error: String(error) } }
    })
    await writeFile(join(run, 'result.json'), JSON.stringify({ ...metadata, shellPassed: true, native, physicalInputTested: false }, null, 2))
    console.log('PACKAGED_SMOKE_EVIDENCE', run)
    expect(native.available, 'Native access must pass separately; shell launch alone is not desktop-control proof.').toBe(true)
  } finally { await closeTestApp(app) }
})
