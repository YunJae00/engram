import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real capture/encoder/artifact pipeline, no AI or application IPC. Only lane
// lookup is supplied by the fixture; masking and encoding are production code.
test('automatic task recording saves a playable MP4 with secret fields masked', async () => {
  test.setTimeout(90_000)
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const temporary = test.info().outputPath('recording')
  await mkdir(temporary, { recursive: true })
  const data = await mkdtemp(join(temporary, 'e2e-task-recording-'))
  const output = join(data, 'artifacts')
  const entry = join(data, 'fixture.mjs')
  await build({
    stdin: { resolveDir: desktop, contents: `
      import { app, BrowserWindow } from 'electron';
      import { chromium } from 'playwright-core';
      import { startTaskRecording } from './src/main/task-recording.ts';
      app.setPath('userData', process.env.ENGRAM_USERDATA);
      app.whenReady().then(async () => {
        const shell = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        await shell.loadURL('data:text/html,<title>Task recording smoke</title>');
        globalThis.recordingSmoke = async ({ url, directory }) => {
          const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
          try {
            const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
            await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
            await page.goto(url, { waitUntil: 'load', timeout: 15000 });
            await page.frameLocator('iframe').locator('input').waitFor({ state: 'visible', timeout: 5000 });
            globalThis.recordingPage = page;
            const dormant = await startTaskRecording('fixture', directory).stop();
            const abort = new AbortController();
            const canceled = startTaskRecording('fixture', directory, abort.signal);
            canceled.observe(); abort.abort();
            const canceledLink = await canceled.stop();
            const before = BrowserWindow.getAllWindows().length;
            const recording = startTaskRecording('fixture', directory);
            recording.observe();
            const link = await recording.stop();
            return { dormant, canceledLink, link, repeated: await recording.stop(), leakedWindows: BrowserWindow.getAllWindows().length - before };
          } finally { globalThis.recordingPage = null; await browser.close(); }
        };
      });
    ` },
    outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'owned-recording-lane', setup(builder) {
      // Keep the production functions without importing the unrelated core
      // barrel's package dependencies into this isolated Electron entry.
      builder.onResolve({ filter: /^core$/ }, () => ({ path: 'core', namespace: 'recording-core' }))
      builder.onLoad({ filter: /.*/, namespace: 'recording-core' }, () => ({
        contents: 'export { saveArtifact } from "./file-work.ts"; export { evidenceRegion } from "./work-evidence.ts"',
        resolveDir: fileURLToPath(new URL('../../../packages/core/src/', import.meta.url)),
      }))
      builder.onResolve({ filter: /^\.\/agent-browser\.js$/ }, () => ({ path: 'lane', namespace: 'recording-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'recording-fixture' }, () => ({ contents: 'export const lanePage = () => globalThis.recordingPage ?? null' }))
    } }],
  })
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/code') res.end('<!doctype html><style>body{margin:0}input{width:180px;height:80px;background:red;border:0;box-sizing:border-box}</style><input autocomplete="section-login one-time-code" value="123456">')
    else res.end('<!doctype html><title>Owned recording fixture</title><style>body{margin:0;background:white}input{position:absolute;left:20px;width:180px;height:80px;border:0;box-sizing:border-box;background:red}iframe{position:absolute;left:20px;top:220px;width:180px;height:80px;border:0}#public{position:absolute;left:300px;top:20px;width:100px;height:100px;background:#00ff00}</style><input type="password" style="top:20px" value="synthetic-password"><input autocomplete="section-billing CC-NUMBER" style="top:120px" value="4111111111111111"><iframe src="/code"></iframe><div id="public"></div>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [entry], env: { ...process.env, ENGRAM_USERDATA: data } })
    app.process().stderr?.on('data', data => console.error(String(data)))
    const shell = await app.firstWindow()
    type Smoke = typeof globalThis & { recordingSmoke(input: { url: string; directory: string }): Promise<{ dormant: string | null; canceledLink: string | null; link: string | null; repeated: string | null; leakedWindows: number }> }
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as Smoke).recordingSmoke)).toBe('function')
    const result = await app.evaluate((_electron, input) => (globalThis as Smoke).recordingSmoke(input), { url: `http://127.0.0.1:${address.port}/`, directory: output })
    expect(result).toMatchObject({ dormant: null, canceledLink: null, leakedWindows: 0 })
    expect(result.link).toMatch(/\(engram-artifact:.*\.mp4\)$/)
    expect(result.repeated).toBe(result.link)
    const files = await readdir(output)
    expect(files).toHaveLength(1)
    const bytes = await readFile(join(output, files[0]!))
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')
    const decoded = await shell.evaluate(async base64 => {
      const video = document.createElement('video'); video.muted = true
      video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'video/mp4' }))
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No decoded recording frame')), 10_000)
          video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve() })
          void video.play().catch(error => { clearTimeout(timer); reject(error) })
        })
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
        const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0)
        const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3)
        return { width: video.videoWidth, height: video.videoHeight, secrets: [pixel(50, 50), pixel(50, 150), pixel(50, 250)], public: pixel(350, 50) }
      } finally { video.pause(); URL.revokeObjectURL(video.src) }
    }, bytes.toString('base64'))
    expect(decoded).toMatchObject({ width: 1280, height: 720 })
    expect(decoded.secrets.every(pixel => pixel.every(value => Math.abs(value - 32) < 6))).toBe(true)
    // MP4 color conversion is lossy; the public patch must remain bright green,
    // not match the original RGB exactly or become a whole-page privacy mask.
    expect(decoded.public[1]).toBeGreaterThan(150)
    expect(decoded.public[1]! - decoded.public[0]!).toBeGreaterThan(100)
    expect(decoded.public[1]! - decoded.public[2]!).toBeGreaterThan(100)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
