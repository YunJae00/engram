import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBot, initVault } from 'core'
import { closeTestApp, openActivity } from './navigation.js'

test('a connected conversation edits an owned app while another conversation receives typing', async () => {
  test.skip(process.platform !== 'darwin' || process.env.ENGRAM_LIVE_BACKGROUND !== '1', 'Requires macOS and an explicitly selected connected provider')
  test.setTimeout(240000)
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const evidence = join(root, 'tmp/app-work-experience')
  await mkdir(evidence, { recursive: true })
  const data = await mkdtemp(join(evidence, 'background-live-'))
  const executable = join(data, 'OwnedFixture')
  execFileSync('xcrun', ['swiftc', '-parse-as-library', join(root, 'apps/desktop/native/macos-test/Fixture.swift'), '-o', executable])
  const fixture = spawn(executable)
  const lines = createInterface({ input: fixture.stdout })
  await once(lines, 'line')
  const paths = await initVault(join(data, 'vault'), { git: false })
  const worker = await createBot(paths, { name: 'Background edit' })
  const human = await createBot(paths, { name: 'My other conversation' })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ defaultEngine: 'codex', codexModel: 'gpt-5.6-terra', computerUse: true, nativeTools: true }))
  await writeFile(join(data, 'candidate.json'), JSON.stringify({ id: process.env.ENGRAM_CANDIDATE_ID ?? 'development', model: process.env.ENGRAM_LIVE_MODEL ?? 'gpt-5.6-terra', window: 'visible', profile: 'isolated tmp', input: 'synthetic' }))
  const events: { type: string; channel?: string; text?: string }[] = []
  const executablePath = process.env.ENGRAM_PACKAGED_APP
  const app = await electron.launch({ ...(executablePath ? { executablePath } : { args: [join(root, 'apps/desktop/out/main/index.js')] }), env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'auto', ENGRAM_HIDDEN: '0', ENGRAM_STEP_DETAIL: '1',
  } })
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.exposeFunction('recordBackgroundEvent', (event: typeof events[number]) => { events.push(event) })
    await page.evaluate(() => window.engram.onEvent(event => { void (window as unknown as { recordBackgroundEvent(event: unknown): Promise<void> }).recordBackgroundEvent(event) }))
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]!.focus() })
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${worker.id}`).click()
    const focused = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      ;(globalThis as unknown as { focusLosses: number }).focusLosses = 0
      window.on('blur', () => { (globalThis as unknown as { focusLosses: number }).focusLosses++ })
      return window.isFocused()
    })
    expect(focused).toBe(true)
    await page.getByTestId('bots-input').fill('In the app window "Engram owned macOS fixture", change only the Fixture message field from "owned fixture initial" to "Background draft verified" and confirm the saved field value. Keep my keyboard focus in Engram. Also read the current Calculator display without changing it. Do not send anything or touch the password field.')
    await page.getByTestId('bots-input').press('Enter')
    await expect.poll(() => events.some(e => e.type === 'comet:step'), { timeout: 60000 }).toBe(true)
    await page.getByTestId(`bot-${human.id}`).click()
    const input = page.getByTestId('bots-input')
    await input.focus()
    const draft = 'This stays in my own conversation. '
    const typing = input.pressSequentially(draft.repeat(20), { delay: 90, timeout: 120000 })
    await expect.poll(() => events.some(e => ['chat:done', 'chat:error'].includes(e.type) && e.channel === `bot-${worker.id}`), { timeout: 150000 }).toBe(true)
    await typing
    if (await page.getByTestId('tour-skip').isVisible()) await page.getByTestId('tour-skip').click()
    await expect(input).toHaveValue(draft.repeat(20))
    await expect(page.getByTestId('work-preview')).toHaveCount(0)
    await page.screenshot({ path: join(data, 'human-session.png') })
    const focusLosses = await app.evaluate(() => (globalThis as unknown as { focusLosses: number }).focusLosses)
    expect(focusLosses).toBe(0)
    await page.getByTestId(`bot-${worker.id}`).click()
    const preview = page.getByTestId('work-preview')
    await expect(preview).toHaveAttribute('data-lane', `bot-${worker.id}`)
    await page.screenshot({ path: join(data, 'worker-collapsed.png') })
    await preview.getByRole('button', { name: 'Expand app activity' }).click()
    await expect(preview.locator('img')).toHaveCount(2)
    await expect(preview.locator('img').first()).toBeVisible()
    await page.screenshot({ path: join(data, 'worker-result.png') })
    await preview.getByRole('button', { name: 'Hide app activity' }).click()
    await expect(preview).toHaveCount(0)
    await page.screenshot({ path: join(data, 'worker-dismissed.png') })
    await page.getByTestId(`bot-${human.id}`).click()
    await expect(page.getByTestId('bots-input')).toHaveValue(draft.repeat(20))
    const audit = (await Promise.all((await readdir(join(paths.cache, 'audit'))).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(paths.cache, 'audit', name), 'utf8')))).join('\n')
    await writeFile(join(data, 'audit.jsonl'), audit)
    const records = audit.split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; tool: string; detail: string })
    expect(records.some(r => r.kind === 'result' && r.tool === 'app_set' && r.detail.includes('Background draft verified') && r.detail.includes('"exact":true'))).toBe(true)
    expect(records.some(r => r.tool === 'desktop_action')).toBe(false)
    for (const record of records.filter(r => r.kind === 'result' && r.tool === 'app_set')) {
      const receipt = JSON.parse(record.detail) as { foregroundChanged: boolean; control: string; appNow: string }
      expect(receipt.foregroundChanged).toBe(false)
      const target = receipt.appNow.split('\n').find(line => line.startsWith(`${receipt.control} depth:`))
      expect(target).toContain('Fixture message')
      expect(target).not.toContain('{secret}')
    }
    expect(events.find(e => e.type === 'chat:done' && e.channel === `bot-${worker.id}`)?.text).toContain('Background draft verified')
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getURL()))
    expect(windows).toHaveLength(1)
    const metadata = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }))
    await writeFile(join(data, 'result.json'), JSON.stringify({ passed: true, metadata, focusLosses, windows, input: 'Synthetic Playwright typing; not physical human input', permission: 'CLI inherited; not standalone packaged authorization', setupIntervention: 'Focused the owned test Engram window before measuring; no activation after task start', events }, null, 2))
    console.log('BACKGROUND_CONVERSATION_EVIDENCE', data)
  } catch (error) {
    await writeFile(join(data, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error))
    throw error
  } finally {
    await writeFile(join(data, 'events.json'), JSON.stringify(events, null, 2))
    try { await closeTestApp(app) } finally { fixture.kill(); lines.close() }
  }
})
