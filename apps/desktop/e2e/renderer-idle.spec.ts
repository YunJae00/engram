import { expect, test, _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test('records ten idle minutes without a renderer task exceeding two seconds', async () => {
  test.skip(process.env['ENGRAM_IDLE_MEASURE'] !== '1', 'Opt-in ten-minute hardware measurement')
  test.setTimeout(660_000)
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'idle-vault-')), { git: false })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'idle-profile-')),
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_STALL_PROFILE: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    const measurement = await page.evaluate(async () => {
      const started = performance.now(), tasks: number[] = [], gaps: number[] = []
      const observer = new PerformanceObserver(list => { for (const task of list.getEntries()) tasks.push(task.duration) })
      observer.observe({ entryTypes: ['longtask'] })
      let previous = performance.now()
      const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now }, 1000)
      await new Promise(resolve => setTimeout(resolve, 600_000))
      clearInterval(timer); observer.disconnect()
      return { elapsedMs: performance.now() - started, longTaskCount: tasks.length, maxLongTaskMs: Math.max(0, ...tasks), stallsOver2s: tasks.filter(ms => ms > 2000).length, heartbeatSamples: gaps.length, maxHeartbeatGapMs: Math.max(0, ...gaps) }
    })
    const visibility = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused() })))
    const evidence = { platform: process.platform, measurement, visibility, windowsMeasured: false }
    await writeFile(join(tmp, 'v0.8.121-renderer-idle.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence))
    expect(measurement.elapsedMs).toBeGreaterThanOrEqual(600_000)
    expect(measurement.stallsOver2s).toBe(0)
    expect(visibility.every(window => !window.focused)).toBe(true)
  } finally { await closeTestApp(app) }
})
