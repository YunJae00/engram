import { expect, test, _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('an offer to look for another way goes when the person writes on instead', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-study-card-'))
  const paths = await initVault(root, { git: false })
  const botId = (await createBot(paths, { name: 'Study fixture' })).id
  await mkdir(paths.cache, { recursive: true })
  await writeFile(join(paths.cache, 'studies.json'), JSON.stringify([{ id: 'study-1', botId, what: 'Where the approvals are kept', where: [], ask: 'Check my approvals', state: 'offered', at: new Date().toISOString() }]))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-study-card-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTestId(`bot-${botId}`).click()
    await expect(page.getByTestId('study-offer')).toBeVisible()
    await page.getByTestId('bots-input').fill('Never mind, look at my calendar instead')
    await page.getByTestId('bots-input').press('Enter')
    await expect(page.getByTestId('study-offer')).toHaveCount(0)
    await expect.poll(async () => (JSON.parse(await readFile(join(paths.cache, 'studies.json'), 'utf8')) as { state: string }[]).map(one => one.state)).toEqual(['declined'])
  } finally { await app.close() }
})
