import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'probe-shot-'))
const userData = await mkdtemp(join(REPO_TMP, 'probe-shot-ud-'))
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

const bots = (await page.evaluate(async () => {
  const a = (await window.engram.botCreate({ name: 'A', purpose: '' })) as { id: string }
  const b = (await window.engram.botCreate({ name: 'B', purpose: '' })) as { id: string }
  return [a.id, b.id]
})) as string[]
const withLanes = process.argv.includes('--lanes')
if (withLanes)
  await page.evaluate(async ({ url, ids }: { url: string; ids: string[] }) => {
    await Promise.all(ids.map((id) => window.engram.agentGo(url, `bot-${id}`)))
  }, { url: siteUrl, ids: bots })

const time = async (label: string, work: () => Promise<unknown>) => {
  const t0 = Date.now()
  try { await work(); console.log(label, Date.now() - t0, 'ms') }
  catch (e) { console.log(label, 'FAILED after', Date.now() - t0, 'ms:', String(e).slice(0, 120)) }
}

// 1. quiet screenshot — no polling running
await time('shot-quiet', () => page.screenshot({ timeout: 15000 }))

// 2. the mission view itself: seat both comets and screenshot over the
// live-updating tiles, the same order the e2e walks.
await page.getByTestId('activity-mission').click()
await page.getByTestId('mission-add-0').click()
await page.getByTestId('mission-add-menu').getByRole('button', { name: 'A', exact: true }).click()
await page.getByTestId('mission-add-1').click()
await page.getByTestId('mission-add-menu').getByRole('button', { name: 'B', exact: true }).click()
if (withLanes) await page.locator('.mission-preview canvas[data-painted]').nth(1).waitFor({ timeout: 20000 })
else await new Promise((r) => setTimeout(r, 2500))
const capturePage = async () => {
  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))
    if (!win) throw new Error('no app window')
    const image = await win.webContents.capturePage()
    return image.toPNG().length
  })
  if (size < 1000) throw new Error(`empty capture: ${size} bytes`)
}
for (let i = 1; i <= 4; i++) await time(`capture-page-${i}`, capturePage)
const save = async (file: string) => {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))
    return (await win!.webContents.capturePage()).toPNG().toString('base64')
  })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(REPO_TMP, file), Buffer.from(data, 'base64'))
  console.log('saved', file)
}
await save('probe-mission-4.png')
await page.getByTestId('mission-layout-2').click()
await new Promise((r) => setTimeout(r, 800))
await save('probe-mission-2.png')
const boxes = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.mission-tile, .mission-enter')]
  return all.map((el) => {
    const r = el.getBoundingClientRect()
    return `${el.className}|${(el as HTMLElement).getAttribute('aria-label') ?? ''}|${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`
  })
})
console.log(boxes.join('\n'))

await app.close()
server.close()
console.log('probe done')
