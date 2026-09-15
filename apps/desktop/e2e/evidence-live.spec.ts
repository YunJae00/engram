import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'

// Opt-in: uses the person's connected provider against an owned local fixture.
for (const engine of ['codex', 'claude'] as const) test(`live ${engine} chat completes browser evidence tools`, async () => {
  test.skip(process.env.ENGRAM_LIVE_EVIDENCE !== engine, 'Requires an explicitly selected connected provider')
  test.setTimeout(900000)
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, `live-evidence-${engine}-`))
  const paths = await initVault(join(data, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Evidence test', purpose: '' })
  const model = process.env.ENGRAM_LIVE_MODEL ?? (engine === 'codex' ? 'gpt-5.5' : 'sonnet')
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: engine, [`${engine}Model`]: model, searchTemplate: 'https://www.google.com/search?q={q}', computerUse: false }))
  let uploaded = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST') { req.on('data', chunk => { uploaded += chunk.length }); req.on('end', () => res.end('saved')); return }
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>Owned evidence test.</p><label>Attach evidence<input type="file" onchange="fetch(\'/upload\',{method:\'POST\',body:this.files[0]}).then(r=>{if(r.ok)document.querySelector(\'#receipt\').textContent=\'Attachment saved\'})"></label><p id="receipt"></p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
  const url = `http://127.0.0.1:${address.port}/`
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0', ENGRAM_STEP_DETAIL: '1' } })
  try {
    const page = await app.firstWindow()
    page.on('console', message => { if (message.text().startsWith('EVIDENCE_STEP')) console.log(message.text()) })
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false)), { timeout: 90000 }).toBe(true)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async (options: { buttons: string[] }) => ({ response: options.buttons.includes('Preview file') ? 2 : 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox })
    const message = `${url} 열고, 녹화 시작해. 페이지에 "Example Domain"이 뜰 때까지 기다렸다가 그 문구가 실제로 보이는지 확인하고, 스크린샷도 저장해. 녹화를 멈춘 다음 저장된 영상 파일을 이 페이지의 "Attach evidence"에 첨부하고 "Attachment saved" 표시를 확인해. 저장된 파일 링크와 경로를 알려줘. 브라우저만 사용해.`
    const result = await page.evaluate(async ({ engine, botId, message }) => {
      const events: unknown[] = []
      const off = window.engram.onEvent(event => { if ('channel' in event && event.channel === `bot-${botId}`) { events.push(event); if (event.type === 'comet:step') console.log('EVIDENCE_STEP', event.line) } })
      try { const answer = await window.engram.chatSend({ engineId: engine, botId, channel: `bot-${botId}`, message, history: [] }); return { answer, events } }
      finally { off() }
    }, { engine, botId: bot.id, message })
    await writeFile(join(data, 'result.json'), JSON.stringify(result, null, 2))
    console.log(`LIVE_EVIDENCE_RESULT ${join(data, 'result.json')}`)
    const audit = await readFile(join(paths.cache, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    for (const tool of ['open_page', 'record_start', 'wait_for', 'verify', 'capture_evidence', 'record_stop', 'upload_file']) expect(audit, tool).toContain(`"tool":"${tool}"`)
    const done = result.events.find(event => (event as { type: string }).type === 'chat:done') as { text: string } | undefined
    expect(done?.text).toContain('engram-artifact:')
    expect(done?.text).not.toContain('Not verified as complete')
    expect(result.events.some(event => (event as { type: string }).type === 'chat:error')).toBe(false)
    expect(uploaded).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.engram.evidenceStatus())).toEqual([])
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
