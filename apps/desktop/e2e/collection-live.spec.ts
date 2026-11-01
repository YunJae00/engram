import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'
import { closeTestApp, openActivity } from './navigation.js'

test('live research preserves a blocked item without looping or claiming verification', async () => {
  test.skip(process.env.ENGRAM_LIVE_COLLECTION !== '1', 'Requires an explicitly selected connected provider')
  test.setTimeout(240000)
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, 'live-collection-'))
  const paths = await initVault(join(data, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Collection access failure' })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: 'codex', codexModel: process.env.ENGRAM_LIVE_MODEL ?? '', computerUse: false }))
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '/')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/b') { res.statusCode = 403; res.end('<h1>403 Forbidden</h1><p>This source is inaccessible. No showtime information is available.</p>'); return }
    if (req.url === '/a' || req.url === '/c') { res.end(`<h1>Movie ${req.url.slice(1).toUpperCase()}</h1><p>Showtime: ${req.url === '/a' ? '14:00' : '18:00'}</p>`); return }
    res.end('<h1>Movies today</h1><ul><li><a href="/a">Movie A</a></li><li><a href="/b">Movie B</a></li><li><a href="/c">Movie C</a></li></ul>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const url = `http://127.0.0.1:${address.port}/`
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url))], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '1', ENGRAM_STEP_DETAIL: '1',
  } })
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const result = await page.evaluate(async ({ botId, url }) => {
      const events: unknown[] = []
      const off = window.engram.onEvent(event => { if ('channel' in event && event.channel === `bot-${botId}`) events.push(event) })
      try {
        await window.engram.chatSend({ engineId: 'codex', botId, channel: `bot-${botId}`, history: [], message: `Read the three movies listed at ${url} and their showtimes from each detail page. Report what you can confirm, and identify anything you cannot confirm. Also read https://example.com and report its main heading as a separate source. Use only these two sites; do not sign in, send messages or change any data.` })
        return events
      } finally { off() }
    }, { botId: bot.id, url })
    await writeFile(join(data, 'events.json'), JSON.stringify(result, null, 2))
    await writeFile(join(data, 'requests.json'), JSON.stringify(requests))
    const audit = await readFile(join(paths.cache, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    const calls = audit.split('\n').filter(line => line.includes('"tool":"collect_results"') && line.includes('"kind":"step"')).length
    const answer = result.filter(event => (event as { type: string }).type === 'chat:done').at(-1) as { text?: string } | undefined
    await page.screenshot({ path: join(data, 'conversation.png') })
    expect(answer?.text).toMatch(/Movie B|403/i)
    expect(answer?.text).toMatch(/unverified|unavailable|inaccessible|could not|cannot|blocked|forbidden/i)
    expect(answer?.text).not.toContain('token budget')
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(12)
    expect(audit).toContain('example.com')
    expect(requests).toContain('/b')
    expect(requests.filter(path => path === '/b').length).toBeLessThanOrEqual(3)
    await page.screenshot({ path: join(data, 'conversation.png') })
    console.log('LIVE_COLLECTION_EVIDENCE', data, JSON.stringify({ calls, blockedRequests: requests.filter(path => path === '/b').length }))
  } finally { await closeTestApp(app); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
