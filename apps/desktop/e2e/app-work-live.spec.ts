import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'
import { closeTestApp, openActivity } from './navigation.js'

test('a connected conversation preserves observed progress and steering while reporting unavailable scope', async () => {
  test.skip(process.env.ENGRAM_LIVE_APP_WORK !== '1', 'Requires the configured connected provider')
  test.setTimeout(240000)
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const evidence = join(root, 'tmp/app-work-experience')
  await mkdir(evidence, { recursive: true })
  const data = await mkdtemp(join(evidence, 'conversation-'))
  const paths = await initVault(join(data, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Four item review' })
  const other = await createBot(paths, { name: 'Other session' })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: 'codex', codexModel: 'gpt-5.6-terra', computerUse: true, nativeTools: true }))
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? '/'; requests.push(path)
    response.setHeader('content-type', 'text/html')
    if (path === '/') response.end('<h1>Review four records</h1>' + [1, 2, 3, 4].map(i => `<p><a href="/item/${i}">Record ${i}</a></p>`).join(''))
    else if (path === '/item/4') { response.statusCode = 403; response.end('<h1>Record 4 unavailable</h1><p>Access denied. No record content is available.</p>') }
    else {
      const i = Number(path.split('/').at(-1))
      setTimeout(() => response.end(`<h1>Record ${i}</h1><p>Title: ${['', 'Amber', 'Birch', 'Cedar'][i] ?? 'Unknown'}</p><p>Date: 2026-10-${20 + i}</p>`), 1500)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address')
  const events: Record<string, unknown>[] = []
  const app = await electron.launch({ args: [join(root, 'apps/desktop/out/main/index.js')], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '0', ENGRAM_BROWSER_EXTERNAL: '1', ENGRAM_STEP_DETAIL: '1',
  } })
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.exposeFunction('recordWorkEvent', (event: Record<string, unknown>) => { events.push(event) })
    await page.evaluate(() => window.engram.onEvent(event => { void (window as unknown as { recordWorkEvent(event: unknown): Promise<void> }).recordWorkEvent(event) }))
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const composer = page.getByTestId('bots-input')
    await composer.fill(`Use the browser to read all four records at http://127.0.0.1:${address.port}/ and summarize each title. Keep me informed when you have actually checked something. Report anything you cannot access honestly; do not retry a denied source or use other sites.`)
    await composer.press('Enter')
    await expect.poll(() => requests.some(path => path.startsWith('/item/')), { timeout: 90000 }).toBe(true)
    await composer.fill('Include the date for each available record too.')
    await composer.press('Enter')
    await expect(composer).toHaveValue('')
    await expect(page.locator('.bubble-msg.user').last()).toContainText('Include the date')
    await page.screenshot({ path: join(data, 'active-steering.png') })
    await expect.poll(() => events.some(e => e.type === 'chat:done' && e.channel === `bot-${bot.id}`), { timeout: 150000 }).toBe(true)
    const answer = String(events.filter(e => e.type === 'chat:done' && e.channel === `bot-${bot.id}`).at(-1)?.text)
    for (const title of ['Amber', 'Birch', 'Cedar']) expect(answer).toContain(title)
    expect(answer).toMatch(/403|unavailable|denied|could not|cannot|unable/i)
    for (const day of ['21', '22', '23']) expect(answer).toContain(`2026-10-${day}`)
    for (const bubble of await page.locator('.bubble-msg.assistant').all())
      await expect(bubble.getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible()
    const before = await page.locator('.bubble-msg').allTextContents()
    await page.screenshot({ path: join(data, 'completed.png') })
    await page.getByTestId(`bot-${other.id}`).click()
    await expect(page.getByTestId('work-preview')).toHaveCount(0)
    await page.getByTestId(`bot-${bot.id}`).click()
    await expect.poll(() => page.locator('.bubble-msg').allTextContents()).toEqual(before)
    const transcript = await page.evaluate(id => window.engram.botTranscript(id), bot.id)
    expect(transcript.some(turn => turn.progress)).toBe(true)
    await page.reload(); await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots'); await page.getByTestId(`bot-${bot.id}`).click()
    for (const turn of transcript.filter(turn => turn.progress)) await expect(page.locator('.bubble-msg.assistant').filter({ hasText: turn.text })).toHaveCount(1)
    await page.screenshot({ path: join(data, 'reloaded.png') })
    const full = await page.locator('.bubble-msg').allTextContents()
    await page.getByTestId('mission-layout-2').click()
    const mini = page.getByTestId(`mini-chat-${bot.id}`)
    await expect.poll(() => mini.locator('.bubble-msg').allTextContents()).toEqual(full)
    await expect(mini.getByRole('textbox')).toBeVisible()
    await page.screenshot({ path: join(data, 'split-result.png') })
    await page.getByTestId('mission-layout-1').click()
    await writeFile(join(data, 'result.json'), JSON.stringify({ passed: true, candidate: process.env.ENGRAM_CANDIDATE_ID, requests, answer, transcript, input: 'Synthetic UI interaction; real configured Codex engine and registered browser tools' }, null, 2))
  } finally {
    await writeFile(join(data, 'events.json'), JSON.stringify(events, null, 2))
    try { await closeTestApp(app) } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    console.log('APP_WORK_EVIDENCE', data)
  }
})
