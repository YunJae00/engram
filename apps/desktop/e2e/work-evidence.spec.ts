import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { initVault } from 'core'

test('external browser tools record masked playable evidence and upload only approved unchanged artifacts', async () => {
  test.setTimeout(240000)
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, 'e2e-evidence-'))
  const vault = join(data, 'vault'); await initVault(vault, { git: false })
  let uploaded = Buffer.alloc(0)
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => { uploaded = Buffer.concat(chunks); res.end('saved') })
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>Evidence fixture</title><style>body{margin:0;background:white}#private{position:absolute;left:0;top:0;width:100px;height:100px;background:red}main{margin:120px}</style><div id="private">Private account</div><main><h1>Ready</h1><button onclick="this.textContent=\'Fixed\'">Reproduce</button><label>Attach evidence<input hidden type="file" onchange="fetch(\'/upload\',{method:\'POST\',body:this.files[0]}).then(r=>{if(r.ok)document.querySelector(\'#receipt\').textContent=\'Attachment saved\'})"></label><p id="receipt"></p></main>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
  const url = `http://127.0.0.1:${address.port}/fixture`
  let app: ElectronApplication | undefined, socket: Socket | undefined
  try {
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0' } })
    const shell = await app.firstWindow()
    await expect(shell.getByTestId('shell')).toBeVisible()
    await expect.poll(() => shell.evaluate(() => window.engram.botsList().then(() => true).catch(() => false)), { timeout: 60000 }).toBe(true)
    // Only this owned test process and localhost destination are approved.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async (options: { buttons: string[] }) => ({ response: options.buttons.includes('Preview file') ? 2 : 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox })
    await shell.evaluate(() => window.engram.mcpEnable(true))
    const endpoint = JSON.parse(await readFile(join(data, 'external-connection.json'), 'utf8'))
    socket = connect(endpoint.pipe)
    const lines = createInterface({ input: socket })
    let serial = 0
    const pending = new Map<string, (reply: { error?: string; result?: { content: { text: string }[] } }) => void>()
    lines.on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id) })
    const call = async (name: string, args: object) => {
      const id = String(++serial)
      const reply = await new Promise<{ error?: string; result?: { content: { text: string }[] } }>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${name}`)) }, 60000)
        pending.set(id, value => { clearTimeout(timer); resolve(value) })
        socket!.write(JSON.stringify({ token: endpoint.token, id, method: 'call', params: { name, args } }) + '\n')
      })
      if (reply.error) throw new Error(reply.error)
      return reply.result!.content[0]!.text
    }
    await call('engram_begin', { goal: 'Record and verify the localhost reproduction fixture, then attach the reviewed evidence.' })
    await call('open_page', { url })
    const check = { id: 'fixed', url, ready: 'Ready', present: ['Fixed'] }
    expect(JSON.parse(await call('verify', check)).verification.status).toBe('failed')
    expect(JSON.parse(await call('wait_for', { ...check, ready: 'Missing heading', timeoutMs: 50 })).verification.status).toBe('inconclusive')
    const capture = { name: 'before', url, masks: ['#private'], build: 'fixture-before', role: 'test', testData: 'owned fixture' }
    const screenshot = JSON.parse(await call('capture_evidence', capture))
    const png = await readFile(screenshot.path)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const pixel = await app.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')); const bitmap = image.toBitmap()
      const offset = (10 * image.getSize().width + 10) * 4
      return [...bitmap.subarray(offset, offset + 3)]
    }, png.toString('base64'))
    expect(pixel).toEqual([32, 32, 32])
    const region = { x: 0, y: 0, width: 100, height: 100 }
    const cropped = JSON.parse(await call('capture_evidence', { ...capture, name: 'region', region }))
    const cropSize = await app.evaluate(({ nativeImage }, base64) => nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).getSize(), (await readFile(cropped.path)).toString('base64'))
    expect(cropSize).toEqual({ width: 100, height: 100 })
    expect(JSON.parse(await call('record_start', { ...capture, region, maxSeconds: 30 })).recording).toBe('started')
    await expect(shell.getByRole('button', { name: 'Stop recording' })).toBeVisible()
    await shell.screenshot({ path: join(data, 'recording-ui.png') })
    await call('press', { target: 'Reproduce' })
    expect(JSON.parse(await call('wait_for', { ...check, timeoutMs: 2000 })).verification.status).toBe('passed')
    expect(JSON.parse(await call('verify', check)).verification.status).toBe('passed')
    const video = JSON.parse(await call('record_stop', {}))
    expect(video.recording).toBe('saved'); expect(video.frames).toBeGreaterThan(1)
    await expect(shell.getByRole('button', { name: 'Stop recording' })).toHaveCount(0)
    const bytes = await readFile(video.path)
    expect(video.path).toMatch(/\.mp4$/)
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')
    const playback = await shell.evaluate(async base64 => {
      const video = document.createElement('video'); video.muted = true
      video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'video/mp4' }))
      try {
        await video.play()
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('No decoded video frame')), 10000); video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve() }) })
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
        const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0)
        return { width: video.videoWidth, height: video.videoHeight, pixel: [...context.getImageData(10, 10, 1, 1).data].slice(0, 3) }
      } finally { video.pause(); URL.revokeObjectURL(video.src) }
    }, bytes.toString('base64'))
    expect(playback).toMatchObject({ width: 100, height: 100 })
    expect(playback.pixel.every(value => Math.abs(value - 32) < 4)).toBe(true)
    const upload = { artifact: video.link, url, target: 'Attach evidence', confirmation: 'Attachment saved' }
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox })
    await expect(call('upload_file', upload)).rejects.toThrow('declined')
    expect(uploaded.length).toBe(0)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async (options: { buttons: string[] }) => ({ response: options.buttons.includes('Preview file') ? 2 : 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox })
    expect(JSON.parse(await call('upload_file', upload)).upload.status).toBe('confirmed')
    expect(createHash('sha256').update(uploaded).digest('hex')).toBe(video.sha256)
    await expect(call('upload_file', upload)).rejects.toThrow('duplicate')
    await expect(shell.getByRole('button', { name: 'Stop recording' })).toHaveCount(0)
    const previewChat = await shell.evaluate(() => window.engram.botCreate({ name: 'Recorded evidence preview' }))
    await shell.getByTestId(`bot-${previewChat.id}`).click()
    await shell.getByTestId('bots-input-files').setInputFiles({ name: 'recording.mp4', mimeType: 'video/mp4', buffer: bytes })
    const player = shell.getByLabel('Attached files').locator('video')
    await expect(player).toBeVisible()
    await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0)
    expect(await player.evaluate(async node => { const video = node as HTMLVideoElement; await video.play(); video.pause(); return video.videoWidth })).toBe(100)
    await shell.screenshot({ path: join(data, 'video-attachment-ui.png') })
  } finally {
    socket?.destroy()
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
