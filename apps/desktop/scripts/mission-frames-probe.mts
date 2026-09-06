import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'probe-mf-'))
const userData = await mkdtemp(join(REPO_TMP, 'probe-mf-ud-'))
const paths = await initVault(root, { git: false })
await createBot(paths, { name: 'Watching', purpose: '' })

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<html><body><h1>page</h1></body></html>')
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const address = server.address() as { port: number }
const siteUrl = `http://127.0.0.1:${address.port}/`

const app = await electron.launch({
  args: [MAIN_ENTRY, '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
})
const page = await app.firstWindow()
await page.waitForSelector('[data-testid="shell"]', { timeout: 60000 })
// The first lane browses the way the person does: chat open, mirror
// streaming — the shape the pull API is asked in after a live session.
await page.evaluate(async () => {
  const installed = (await window.engram.browsersInstalled()) as { path: string }[]
  if (installed[0]) await window.engram.browserChoose(installed[0].path)
})
await page.getByTestId('activity-bots').click()
await page.locator('.bots-row', { hasText: 'Watching' }).click()
await page.evaluate(() => window.engram.agentWatch(true))
await page.evaluate((url) => window.engram.agentGo(url), siteUrl)
await page.getByTestId('web-pane').waitFor({ timeout: 60000 })
const first = (await page.evaluate(() => window.engram.botsList())) as { id: string }[]
const ids: string[] = [first[0]!.id]
for (const name of ['B', 'C', 'D']) {
  const bot = (await page.evaluate((n: string) => window.engram.botCreate({ name: n, purpose: '' }), name)) as { id: string }
  ids.push(bot.id)
}
await page.evaluate(({ url, all }: { url: string; all: string[] }) =>
  Promise.all(all.map((id, i) => window.engram.agentGo(`${url}?q=${i}`, `bot-${id}`))), { url: siteUrl, all: ids.slice(1) })
for (let i = 0; i < 8; i++) {
  const t0 = Date.now()
  const frames = (await page.evaluate((all: string[]) => window.engram.missionFrames(all.map((id) => `bot-${id}`)), ids)) as { on: boolean; url?: string; data?: string }[]
  console.log(i, Date.now() - t0, 'ms', JSON.stringify(frames.map((f) => ({ on: f.on, data: f.data ? f.data.length : null }))))
  await new Promise((r) => setTimeout(r, 1000))
}
await app.close()
server.close()
console.log('probe done')
