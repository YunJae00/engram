import { test, expect, _electron as electron } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'
import { closeTestApp, openActivity } from './navigation.js'

test('a connected conversation stops an unfinished read and resumes without another queued turn', async () => {
  test.skip(process.env.ENGRAM_LIVE_CONTINUITY !== '1', 'Requires an explicitly selected connected provider')
  test.setTimeout(240000)
  const root = fileURLToPath(new URL('../../../tmp/session-preview-followup/', import.meta.url))
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, 'continuity-live-'))
  const paths = await initVault(join(data, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Stop and continue' })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: 'codex', codexModel: 'gpt-5.6-terra', computerUse: true, nativeTools: true }))
  const pending: ServerResponse[] = []
  let available = false, requests = 0
  const respond = (response: ServerResponse) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Reading resumed</h1><p>The reference number is 742.</p>') }
  const server = createServer((request, response) => { if (request.url === '/') requests++; if (available) respond(response); else pending.push(response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url))], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '0', ENGRAM_BROWSER_EXTERNAL: '1', ENGRAM_STEP_DETAIL: '1',
  } })
  await writeFile(join(data, 'candidate.json'), JSON.stringify({ id: process.env.ENGRAM_CANDIDATE_ID ?? 'development', model: process.env.ENGRAM_LIVE_MODEL ?? 'gpt-5.6-terra', window: 'visible', profile: 'isolated tmp', input: 'synthetic' }))
  const events: { type: string; channel?: string; text?: string }[] = []
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.exposeFunction('recordContinuityEvent', (event: typeof events[number]) => { events.push(event) })
    await page.evaluate(() => window.engram.onEvent(event => { void (window as unknown as { recordContinuityEvent(event: unknown): Promise<void> }).recordContinuityEvent(event) }))
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    await page.getByTestId('bots-input').fill(`Read http://127.0.0.1:${address.port}/ and tell me its reference number. Use only this site.`)
    await page.getByTestId('bots-input').press('Enter')
    await expect.poll(() => requests, { timeout: 60000 }).toBeGreaterThan(0)
    const first = await page.evaluate(async botId => (await window.engram.tasksList()).find(task => task.botId === botId), bot.id)
    expect(first?.state).toBe('running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => page.evaluate(async id => (await window.engram.tasksList()).find(task => task.id === id)?.state, first!.id)).toBe('stopped')
    await page.screenshot({ path: join(data, 'stopped.png') })
    available = true
    for (const response of pending) respond(response)
    if (await page.getByTestId('tour-skip').isVisible()) await page.getByTestId('tour-skip').click()
    const from = events.length
    await page.getByTestId('bots-input').fill('Continue checking that page and tell me the reference number.')
    await page.getByTestId('bots-input').press('Enter')
    await expect.poll(() => events.slice(from).some(e => e.type === 'chat:done' && e.channel === `bot-${bot.id}`), { timeout: 150000 }).toBe(true)
    if (await page.getByTestId('tour-skip').isVisible()) await page.getByTestId('tour-skip').click()
    const answers = events.slice(from).filter(e => e.type === 'chat:done' && e.channel === `bot-${bot.id}`)
    expect(answers).toHaveLength(1)
    expect(answers[0]?.text).toContain('742')
    const tasks = await page.evaluate(async botId => (await window.engram.tasksList()).filter(task => task.botId === botId), bot.id)
    expect(tasks.filter(task => ['queued', 'running'].includes(task.state))).toEqual([])
    expect(tasks.find(task => task.id === first!.id)?.state).toBe('stopped')
    expect(requests).toBeLessThanOrEqual(3)
    await page.screenshot({ path: join(data, 'resumed.png') })
    await writeFile(join(data, 'result.json'), JSON.stringify({ passed: true, requests, tasks, events, input: 'Synthetic UI input; read-only fixture, not proof of irreversible external actions' }, null, 2))
    console.log('CONTINUITY_EVIDENCE', data)
  } finally {
    available = true
    for (const response of pending) if (!response.writableEnded) respond(response)
    await writeFile(join(data, 'events.json'), JSON.stringify(events, null, 2))
    try { await closeTestApp(app) } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})
