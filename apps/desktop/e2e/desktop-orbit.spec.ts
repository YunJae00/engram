import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.describe.configure({ mode: 'serial' })

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let closing = false
const children: ChildProcessWithoutNullStreams[] = []
let lanes: string[] = []
let titles: string[] = []
const captureSizes: { width: number; height: number }[] = []
// Video capture aligns chroma planes to even pixel dimensions.
const expectedVideoSizes = () => captureSizes.map(({ width, height }) => ({ width: Math.floor(width / 2) * 2, height: Math.floor(height / 2) * 2, ready: 4 }))

async function resizeFixture(index: number, width: number, height: number): Promise<{ width: number; height: number }> {
  const child = children[index]!
  const reader = createInterface({ input: child.stdout })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reader.close(); reject(new Error('Fixture did not resize')) }, 10000)
    reader.on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; error?: string; result?: { captureWidth: number; captureHeight: number } }
      if (message.id !== 31) return
      clearTimeout(timer); reader.close()
      if (message.error || !message.result) { reject(new Error(message.error || 'Missing fixture resize state')); return }
      resolve({ width: message.result.captureWidth, height: message.result.captureHeight })
    })
    child.stdin.write(JSON.stringify({ id: 31, method: 'resize', width, height }) + '\n')
  })
}
const videoSizes = () => page.locator('.desktop-video video').evaluateAll((elements) => elements.map((element) => {
  const video = element as HTMLVideoElement
  return { width: video.videoWidth, height: video.videoHeight, ready: video.readyState }
}))

test.beforeAll(async () => {
  if (process.platform !== 'win32') return
  await mkdir(TMP, { recursive: true })
  const output = await mkdtemp(join(TMP, 'desktop-orbit-fixture-'))
  const fixture = join(output, 'OrbitCaptureFixture.exe')
  const compiler = join(process.env['WINDIR'] ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${fixture}`,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'].map((name) => `/reference:${name}`),
    ...['DesktopFixture.cs', 'FixturePrivilege.cs', 'FixtureTokenSecurity.cs'].map((name) => fileURLToPath(new URL(`./fixtures/desktop/${name}`, import.meta.url)))], { windowsHide: true })
  titles = await Promise.all([1, 2, 3, 4].map(async (index) => {
    const child = spawn(fixture, [`Orbit ${index}`, '--visible', '--restricted-fixture'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    child.stderr.resume()
    return new Promise<string>((resolve, reject) => {
      const reader = createInterface({ input: child.stdout })
      const fail = (error: Error) => { clearTimeout(timer); reader.close(); reject(error) }
      const timer = setTimeout(() => fail(new Error(`Capture fixture ${index} did not start`)), 15000)
      reader.on('line', (line) => {
        const event = JSON.parse(line) as { type?: string; title?: string; error?: string; captureWidth: number; captureHeight: number }
        if (event.type === 'fatal') { fail(new Error(`Capture fixture ${index}: ${event.error}`)); return }
        if (event.type === 'ready' && event.title) {
          captureSizes[index - 1] = { width: event.captureWidth, height: event.captureHeight }
          clearTimeout(timer); reader.close(); resolve(event.title)
        }
      })
      child.once('error', fail)
      child.once('exit', (code) => fail(new Error(`Capture fixture ${index} exited: ${code === null ? 'terminated' : `0x${(code >>> 0).toString(16)}`}`)))
    })
  }))
  const vault = await mkdtemp(join(TMP, 'desktop-orbit-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'desktop-orbit-userdata-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  app.process().once('exit', (code, signal) => {
    if (!closing) process.stderr.write(`Capture app exited: code=${code}, signal=${signal}\n`)
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.webContents.setBackgroundThrottling(true)
    window.showInactive()
  })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  lanes = await page.evaluate(async () => {
    const ids = []
    for (let index = 1; index <= 4; index++) ids.push((await window.engram.botCreate({ name: `Desktop lane ${index}`, purpose: '' })).id)
    localStorage.setItem('engram.mission.slots', JSON.stringify(ids))
    return ids.map((id) => `bot-${id}`)
  })
})

test.afterAll(async () => {
  closing = true
  await app?.close()
  for (const child of children) { child.stdin.end(); if (child.exitCode === null) child.kill() }
})

test('Orbit renders four real app streams and keeps capture scoped to chosen windows', async () => {
  test.skip(process.platform !== 'win32', 'App window sharing is Windows-only in this build')
  const sources = await page.evaluate(() => window.engram.desktopWindows())
  for (let index = 0; index < titles.length; index++) {
    const source = sources.find((item) => item.name === titles[index])
    expect(source, `Own capture fixture ${titles[index]} is available`).toBeTruthy()
    await page.evaluate(({ lane, id }) => window.engram.desktopChoose(lane, id), { lane: lanes[index]!, id: source!.id })
  }
  await page.getByTestId('activity-mission').click()
  await expect(page.locator('.desktop-video video')).toHaveCount(4)
  await expect.poll(videoSizes, { timeout: 30000 }).toEqual(expectedVideoSizes())
  const resize = await app.evaluate(({ screen }) => {
    const { workAreaSize, scaleFactor } = screen.getPrimaryDisplay()
    // Keep the fixture inside the physical work area on small virtual displays.
    return { width: Math.min(1152, Math.floor(workAreaSize.width * scaleFactor) - 96), height: Math.min(900, Math.floor(workAreaSize.height * scaleFactor) - 96) }
  })
  const initialSize = captureSizes[0]!
  captureSizes[0] = await resizeFixture(0, resize.width, resize.height)
  expect(captureSizes[0]).not.toEqual(initialSize)
  await expect.poll(videoSizes).toEqual(expectedVideoSizes())
  await expect(page.getByRole('button', { name: 'View only', exact: true })).toHaveCount(4)
  expect(await page.evaluate(async (lane) => {
    try { await window.engram.desktopObserve(lane); return 'unexpectedly allowed' } catch (error) { return String(error) }
  }, lanes[0]!)).toContain('Enable AI read access')
  expect(await page.evaluate(async () => {
    try { const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); stream.getTracks().forEach((track) => track.stop()); return 'unexpectedly allowed' }
    catch { return 'denied' }
  })).toBe('denied')
  const frames = await page.locator('.desktop-video video').evaluateAll((elements) => elements.map((element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames))
  await expect.poll(() => page.locator('.desktop-video video').evaluateAll((elements) => elements.map((element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)).then((counts) => counts.every((count, index) => count > frames[index]!))).toBe(true)
  const streams = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLVideoElement>('.desktop-video video')].flatMap((video) => (video.srcObject as MediaStream).getTracks()))
  expect(await streams.evaluate((tracks) => tracks.every((track) => track.kind === 'video' && track.readyState === 'live'))).toBe(true)
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    await window.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, 'orbit-desktop-live.png'), Buffer.from(png, 'base64'))
  await page.getByRole('button', { name: 'Open Desktop lane 1', exact: true }).click()
  await expect(page.getByTestId('desktop-chat-pane')).toBeVisible()
  await expect(page.locator('.desktop-video video')).toHaveCount(1)
  await expect.poll(videoSizes).toEqual([expectedVideoSizes()[0]])
  await expect.poll(() => streams.evaluate((tracks) => tracks.every((track) => track.readyState === 'ended'))).toBe(true)
  await streams.dispose()
  await page.getByTestId('desktop-pane-fold').click()
  await expect(page.locator('.desktop-video video')).toHaveCount(0)
  await page.getByTestId('activity-mission').click()
  await expect(page.locator('.desktop-video video')).toHaveCount(4)
  await expect.poll(videoSizes).toEqual(expectedVideoSizes())
  const visibleTracks = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLVideoElement>('.desktop-video video')].flatMap((video) => (video.srcObject as MediaStream).getTracks()))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide())
  await expect.poll(() => visibleTracks.evaluate((tracks) => tracks.every((track) => track.readyState === 'ended'))).toBe(true)
  await visibleTracks.dispose()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive())
  await expect.poll(videoSizes).toEqual(expectedVideoSizes())
  await page.getByRole('button', { name: 'Return to browser', exact: true }).first().click()
  await expect(page.locator('.desktop-video video')).toHaveCount(3)
  expect(await page.evaluate(() => window.engram.desktopBindings().then((items) => items.length))).toBe(3)
})

test('app reading uses the real helper and can be revoked without stopping the window view', async () => {
  test.skip(process.platform !== 'win32', 'App window sharing is Windows-only in this build')
  // Only the test-owned app's review dialogs are replaced; real user apps are never authorized.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  const lane = lanes[1]!
  await page.evaluate((id) => window.engram.desktopReadAccess(id, true), lane)
  const observation = await page.evaluate((id) => window.engram.desktopObserve(id), lane)
  const field = observation.nodes.find((node) => node.name === 'Task value')!
  expect(field).toBeDefined()
  expect(JSON.stringify(observation)).not.toContain('fixture-only-password')
  expect(await page.evaluate(() => 'desktopAct' in window.engram)).toBe(false)
  await page.evaluate((id) => window.engram.desktopReadAccess(id, false), lane)
  expect(await page.evaluate(async (id) => {
    try { await window.engram.desktopObserve(id); return 'unexpectedly allowed' } catch (error) { return String(error) }
  }, lane)).toContain('Enable AI read access')
  await page.getByTestId('activity-bots').click()
  await page.getByTestId('activity-mission').click()
  await expect.poll(() => page.locator('.desktop-video video').evaluateAll((elements) => elements.every((element) => (element as HTMLVideoElement).readyState === 4))).toBe(true)
})
