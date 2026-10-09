import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { initVault } from 'core'

test('external browser tools capture masked screenshots and upload only approved unchanged artifacts', async () => {
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
    if (req.url === '/code') { res.end('<!doctype html><style>body{margin:0}input{width:100px;height:100px;background:red;border:0;box-sizing:border-box}</style><input autocomplete="section-login one-time-code" value="123456">'); return }
    res.end('<!doctype html><title>Evidence fixture</title><style>body{margin:0;background:white}.patch{position:absolute;top:0;width:100px;height:100px;background:red;border:0;box-sizing:border-box}main{margin:140px 120px}#private{left:0}#public{left:480px;background:#00ff00}</style><div id="private" class="patch">Private account</div><input class="patch" style="left:120px" autocomplete="current-password" value="synthetic-secret"><input class="patch" style="left:240px" autocomplete="section-billing CC-NUMBER" value="4111111111111111"><iframe class="patch" style="left:360px" src="/code"></iframe><div id="public" class="patch"></div><main><h1>Ready</h1><button onclick="this.textContent=\'Fixed\'">Reproduce</button><label>Attach evidence<input hidden type="file" onchange="fetch(\'/upload\',{method:\'POST\',body:this.files[0]}).then(r=>{if(r.ok)document.querySelector(\'#receipt\').textContent=\'Attachment saved\'})"></label><p id="receipt"></p></main>')
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
    await call('engram_begin', { goal: 'Verify the localhost reproduction fixture, then attach the reviewed screenshot.' })
    for (const tool of ['record_start', 'record_stop']) await expect(call(tool, {})).rejects.toThrow('Unknown or unavailable tool')
    expect(await shell.evaluate(() => 'evidenceStatus' in window.engram || 'evidenceStop' in window.engram)).toBe(false)
    await call('open_page', { url })
    const check = { id: 'fixed', url, ready: 'Ready', present: ['Fixed'] }
    expect(JSON.parse(await call('verify', check)).verification.status).toBe('failed')
    expect(JSON.parse(await call('wait_for', { ...check, ready: 'Missing heading', timeoutMs: 50 })).verification.status).toBe('inconclusive')
    const capture = { name: 'before', url, masks: ['#private'], build: 'fixture-before', role: 'test', testData: 'owned fixture' }
    const screenshot = JSON.parse(await call('capture_evidence', capture))
    const png = await readFile(screenshot.path)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const pixels = await app.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')); const bitmap = image.toBitmap()
      return [10, 130, 250, 370, 490].map(x => {
        const offset = (10 * image.getSize().width + x) * 4
        return [...bitmap.subarray(offset, offset + 3)]
      })
    }, png.toString('base64'))
    expect(pixels.slice(0, 4)).toEqual(Array.from({ length: 4 }, () => [32, 32, 32]))
    expect(pixels[4]).toEqual([0, 255, 0])
    const provenanceId = /\(engram-artifact:([^)]+)\)/.exec(screenshot.provenance)?.[1]
    expect(provenanceId).toBeTruthy()
    const provenance = JSON.parse(await readFile(join(dirname(screenshot.path), decodeURIComponent(provenanceId!)), 'utf8'))
    expect(provenance).toMatchObject({ url, build: 'fixture-before', role: 'test', sha256: screenshot.sha256 })
    await expect(call('capture_evidence', { ...capture, masks: ['#missing'] })).rejects.toThrow('redaction target')
    await expect(call('capture_evidence', { ...capture, region: { x: 0, y: 0, width: 16384, height: 16384 } })).rejects.toThrow('outside the current viewport')
    const region = { x: 0, y: 0, width: 100, height: 100 }
    const cropped = JSON.parse(await call('capture_evidence', { ...capture, name: 'region', region }))
    const cropSize = await app.evaluate(({ nativeImage }, base64) => nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).getSize(), (await readFile(cropped.path)).toString('base64'))
    expect(cropSize).toEqual({ width: 100, height: 100 })
    await call('press', { target: 'Reproduce' })
    expect(JSON.parse(await call('wait_for', { ...check, timeoutMs: 2000 })).verification.status).toBe('passed')
    expect(JSON.parse(await call('verify', check)).verification.status).toBe('passed')
    const after = JSON.parse(await call('capture_evidence', { ...capture, name: 'after', build: 'fixture-after' }))
    const bytes = await readFile(after.path)
    expect(after.path).toMatch(/\.png$/)
    expect(after.sha256).not.toBe(screenshot.sha256)
    await writeFile(cropped.path, Buffer.concat([await readFile(cropped.path), Buffer.from('changed')]))
    const upload = { artifact: after.link, url, target: 'Attach evidence', confirmation: 'Attachment saved' }
    await expect(call('upload_file', { ...upload, artifact: cropped.link })).rejects.toThrow('changed')
    expect(uploaded.length).toBe(0)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox })
    await expect(call('upload_file', upload)).rejects.toThrow('declined')
    expect(uploaded.length).toBe(0)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async (options: { buttons: string[] }) => ({ response: options.buttons.includes('Preview file') ? 2 : 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox })
    expect(JSON.parse(await call('upload_file', upload)).upload.status).toBe('confirmed')
    expect(createHash('sha256').update(uploaded).digest('hex')).toBe(after.sha256)
    await expect(call('upload_file', upload)).rejects.toThrow('duplicate')
    await expect(shell.getByRole('button', { name: 'Stop recording' })).toHaveCount(0)
    expect((await readdir(dirname(after.path))).some(name => /\.(mp4|webm)$/i.test(name))).toBe(false)
    const previewChat = await shell.evaluate(() => window.engram.botCreate({ name: 'Screenshot evidence preview' }))
    await shell.getByTestId(`bot-${previewChat.id}`).click()
    await shell.getByTestId('bots-input-files').setInputFiles({ name: 'after.png', mimeType: 'image/png', buffer: bytes })
    const preview = shell.getByLabel('Attached files').getByRole('img', { name: 'after.png' })
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await shell.screenshot({ path: join(data, 'screenshot-attachment-ui.png') })
  } finally {
    socket?.destroy()
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
