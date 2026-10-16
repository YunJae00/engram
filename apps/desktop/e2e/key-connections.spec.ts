import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initVault } from 'core'
import { openActivity } from './navigation.js'

test('API connection tests the selected model before saving, keeps keys encrypted and can be removed', async () => {
  test.setTimeout(60_000)
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const vault = await mkdtemp(join(root, 'e2e-key-vault-'))
  const userData = await mkdtemp(join(root, 'e2e-key-data-'))
  await initVault(vault, { git: false })
  let completed = false, requests = 0
  const gateway = createServer((request, response) => {
    request.resume()
    if (request.url !== '/v1/responses' || request.method !== 'POST' || request.headers.authorization !== 'Bearer synthetic-api-key') { response.writeHead(401).end(); return }
    requests++
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(completed ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] } : { data: [{ id: 'synthetic-model' }] }))
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw new Error('The owned gateway did not open')
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userData, ENGRAM_ENGINE: 'none', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_HIDDEN: '1' } })
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-ai').click()
    await expect(page.getByRole('region', { name: 'Decision model connection' })).toBeVisible()
    await page.getByTestId('key-connection-codex-open').click()
    await page.getByTestId('key-connection-codex-url').fill(`http://127.0.0.1:${address.port}/v1`)
    await page.getByTestId('key-connection-codex-key').fill('synthetic-api-key')
    await page.getByTestId('key-connection-codex-model').fill('synthetic-model')
    await page.getByTestId('key-connection-codex-save').click()
    await expect(page.getByTestId('key-connection-codex').getByRole('alert')).toContainText('completed answer')
    await expect(readFile(join(userData, 'connections.json'), 'utf8')).rejects.toThrow()
    completed = true
    await page.getByTestId('key-connection-codex-save').click()
    await expect(page.getByTestId('key-connection-codex')).toContainText('model tested when saved')
    expect(requests).toBe(2)
    const stored = await readFile(join(userData, 'connections.json'), 'utf8')
    expect(stored).not.toContain('synthetic-api-key')
    expect(JSON.parse(stored).codex.encrypted).toBe(true)
    expect(await page.evaluate(async () => (await window.engram.brainConnectionGet('codex')))).toMatchObject({ model: 'synthetic-model', usable: true, keyHint: '…-key' })
    await page.getByTestId('key-connection-codex-remove').click()
    await expect(page.getByTestId('key-connection-codex-open')).toBeVisible()
    expect(JSON.parse(await readFile(join(userData, 'connections.json'), 'utf8')).codex).toBeUndefined()
  } finally {
    await app?.close()
    gateway.closeAllConnections()
    await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
  }
})
