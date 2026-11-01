import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'
import { closeTestApp, openActivity } from './navigation.js'

test('connected conversations deliver visible results with isolated work surfaces', async () => {
  test.skip(process.env.ENGRAM_LIVE_JOURNEY !== '1', 'Requires an explicitly selected connected provider')
  test.setTimeout(480000)
  const root = fileURLToPath(new URL('../../../tmp/session-preview-followup/', import.meta.url))
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, process.env.ENGRAM_JOURNEY_APP ? 'baseline-' : 'candidate-'))
  const paths = await initVault(join(data, 'vault'), { git: false })
  const browser = await createBot(paths, { name: 'Source check' })
  const desktop = await createBot(paths, { name: 'App check' })
  const calculator = await createBot(paths, { name: 'Calculator check' })
  const clean = await createBot(paths, { name: 'Complete research' })
  const model = process.env.ENGRAM_LIVE_MODEL ?? 'gpt-5.6-terra'
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: 'codex', codexModel: model, computerUse: true, nativeTools: true }))
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '/')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/clean') { res.end('<h1>Movies</h1><a href="/a">Movie A</a><a href="/c">Movie C</a>'); return }
    if (req.url === '/c') { res.end('<h1>Movie C</h1><p>Showtime: 18:00</p>'); return }
    if (req.url === '/b') { res.statusCode = 403; res.end('<h1>403 Forbidden</h1><p>Seat availability cannot be checked.</p>'); return }
    if (req.url === '/a') { res.end('<h1>Movie A</h1><p>Showtime: 14:00. Seat availability is not published.</p>'); return }
    res.end('<h1>Movies today</h1><a href="/a">Movie A</a><a href="/b">Movie B</a>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address')
  const url = `http://127.0.0.1:${address.port}/`
  const executablePath = process.env.ENGRAM_JOURNEY_APP
  const app = await electron.launch({ ...(executablePath ? { executablePath } : { args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url))] }), env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '0', ENGRAM_BROWSER_EXTERNAL: '1', ENGRAM_STEP_DETAIL: '1',
  } })
  await writeFile(join(data, 'candidate.json'), JSON.stringify({ id: process.env.ENGRAM_CANDIDATE_ID ?? 'development', model: process.env.ENGRAM_LIVE_MODEL ?? 'gpt-5.6-terra', window: 'visible', profile: 'isolated tmp', input: 'synthetic' }))
  const events: unknown[] = []
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.exposeFunction('recordJourneyEvent', (event: unknown) => { events.push(event) })
    await page.evaluate(() => window.engram.onEvent(event => { void (window as unknown as { recordJourneyEvent(event: unknown): Promise<void> }).recordJourneyEvent(event) }))
    await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
    await openActivity(page, 'bots')
    const prompts = [
      { bot: browser, text: `Read ${url} and its two movie details. Tell me each movie's showtime and whether seats are available. Clearly distinguish what you read from what cannot be checked. Do not invent availability. Use only this site; do not reserve, sign in or send anything.` },
      { bot: desktop, text: 'Open KakaoTalk by its name 카카오톡 without activation. Report whether the launch request was accepted. Do not read its window contents, log in, type or send anything.' },
      { bot: calculator, text: 'Open Calculator, read its current display using app_read and look_desktop, and tell me what is shown. Do not press any buttons or change the calculation. If access is blocked, explain it honestly.' },
      { bot: clean, text: `Read ${url}clean and list each movie's showtime. Also check the main heading at https://example.com. Use these sites only.` },
    ]
    for (const [index, scenario] of prompts.entries()) {
      const only = process.env.ENGRAM_JOURNEY_ONLY
      if (only && index !== ({ desktop: 1, calculator: 2, clean: 3 } as Record<string, number>)[only]) continue
      if (await page.getByTestId('tour-skip').isVisible()) await page.getByTestId('tour-skip').click()
      await page.getByTestId(`bot-${scenario.bot.id}`).click()
      await page.getByTestId('bots-input').fill(scenario.text)
      await page.getByTestId('bots-input').press('Enter')
      await expect.poll(() => events.some(e => (e as { type: string; channel?: string }).type === 'comet:step' && (e as { channel?: string }).channel === `bot-${scenario.bot.id}`), { timeout: 60000 }).toBe(true)
      if (index === 2) await expect(page.getByTestId('work-preview').locator('img').first()).toBeVisible({ timeout: 60000 })
      await page.screenshot({ path: join(data, `session-${index}-active.png`) })
      await expect.poll(() => events.some(e => ['chat:done', 'chat:error'].includes((e as { type: string }).type) && (e as { channel?: string }).channel === `bot-${scenario.bot.id}`), { timeout: 150000 }).toBe(true)
      await expect.poll(() => page.locator('.bubble-msg.assistant .answer-actions').count()).toBe(await page.locator('.bubble-msg.assistant').count())
      if (await page.getByTestId('tour-skip').isVisible()) await page.getByTestId('tour-skip').click()
      await page.screenshot({ path: join(data, `session-${index}-result.png`) })
      const preview = page.getByTestId('work-preview')
      if (index === 2) {
        await expect(preview).toHaveAttribute('data-lane', `bot-${calculator.id}`)
        await expect(preview).toHaveCount(1)
      }
      if (await preview.isVisible()) {
        const expand = preview.getByRole('button', { name: /Expand app activity|앱 작업 펼치기/ })
        if (await expand.isVisible()) await expand.click()
        await expect(preview.locator('img').first()).toBeVisible()
        await page.screenshot({ path: join(data, `session-${index}-preview.png`) })
        await page.getByTestId(`bot-${browser.id}`).click()
        await expect(page.getByTestId('work-preview')).toHaveCount(0)
        await page.screenshot({ path: join(data, `session-${index}-switched.png`) })
        await page.getByTestId(`bot-${scenario.bot.id}`).click()
        await expect(page.getByTestId('work-preview')).toHaveAttribute('data-lane', `bot-${scenario.bot.id}`)
      }
    }
    const metadata = await app.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), packaged: app.isPackaged, windows: BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), focusable: w.isFocusable() })) }))
    expect(metadata.windows.filter(w => w.url.includes('work-preview'))).toHaveLength(0)
    expect(metadata.windows).toHaveLength(1)
    const audit = (await Promise.all((await readdir(join(paths.cache, 'audit'))).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(paths.cache, 'audit', name), 'utf8')))).join('\n')
    await writeFile(join(data, 'audit.jsonl'), audit)
    await writeFile(join(data, 'result.json'), JSON.stringify({ metadata, model, requests, prompts, events, input: 'Playwright synthetic UI input', permissionAttribution: 'CLI launched; does not establish standalone Engram authorization' }, null, 2))
    const answers = events.filter(e => (e as { type: string }).type === 'chat:done') as { text: string; channel: string }[]
    if (!process.env.ENGRAM_JOURNEY_ONLY) expect(answers.find(a => a.channel === `bot-${browser.id}`)?.text).toMatch(/cannot|unavailable|could not|not (?:published|verified)|inaccessible|unconfirmed|unknown|403/i)
    const records = audit.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { channel: string; tool: string; kind: string; detail: string })
    if (!process.env.ENGRAM_JOURNEY_ONLY || process.env.ENGRAM_JOURNEY_ONLY === 'desktop') {
      const opens = records.filter(r => r.channel === `bot-${desktop.id}` && r.tool === 'open_app' && r.kind === 'result')
      expect(opens).toHaveLength(1)
      expect(opens[0]!.detail).toContain('accepted the launch request')
      expect(answers.find(a => a.channel === `bot-${desktop.id}`)?.text).not.toMatch(/not installed|uninstalled|설치되지|찾지 못했/)
    }
    if (!process.env.ENGRAM_JOURNEY_ONLY) {
      expect(requests).toContain('/b')
      expect(answers.find(a => a.channel === `bot-${browser.id}`)?.text).toContain('14:00')
      expect(records.filter(r => r.channel === `bot-${browser.id}` && r.tool === 'collect_results' && r.kind === 'step').length).toBeLessThanOrEqual(6)
    }
    if (!process.env.ENGRAM_JOURNEY_ONLY || process.env.ENGRAM_JOURNEY_ONLY === 'calculator') {
      expect(records.some(r => r.channel === `bot-${calculator.id}` && ['app_read', 'look_desktop'].includes(r.tool) && r.kind === 'result' && !r.detail.startsWith('that did not work:'))).toBe(true)
      expect(answers.find(a => a.channel === `bot-${calculator.id}`)?.text).toMatch(/579|123.*456/)
    }
    if (!process.env.ENGRAM_JOURNEY_ONLY || process.env.ENGRAM_JOURNEY_ONLY === 'clean') {
      const answer = answers.find(a => a.channel === `bot-${clean.id}`)?.text ?? ''
      expect(answer).toContain('14:00'); expect(answer).toContain('18:00'); expect(answer).toContain('Example Domain')
      expect(answer).not.toContain('Not verified as complete')
      expect(records.some(r => r.channel === `bot-${clean.id}` && r.tool === 'collect_results' && r.kind === 'result' && r.detail.includes('"status":"complete"'))).toBe(true)
    }
    console.log('SESSION_JOURNEY_EVIDENCE', data)
  } finally {
    await writeFile(join(data, 'events.json'), JSON.stringify(events, null, 2))
    await closeTestApp(app); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
