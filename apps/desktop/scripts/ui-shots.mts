// Screenshots of the surfaces the polish touched, for a human look.
import { launchApp } from './launch-app.mts'
import { createCard, createNote, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const RUN = Date.now().toString(36)
const VAULT = fileURLToPath(new URL(`../../../tmp/shots-${RUN}-vault/`, import.meta.url))
const USERDATA = fileURLToPath(new URL(`../../../tmp/shots-${RUN}-userdata/`, import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/ui-review/', import.meta.url))
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const deploy = await createNote(paths, { body: '# Deploy decision\n\nThursday afternoons, helm charts.' })
await createNote(paths, { body: '# Team contacts\n\nDeploys: Jiwoo (x4192).' })
await createCard(paths, {
  cardType: 'supersede',
  targets: [deploy.front.id],
  rationale: 'The deployment window moved.',
  proposed: '# Deploy decision\n\nFriday mornings, helm charts.',
})

const app = await launchApp({ ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' })
const page = app.page
await page.setViewportSize({ width: 1280, height: 840 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 120_000 })
const shot = (name: string) => page.screenshot({ path: `${OUT}${name}.png` })
const layout = async (name: string) => {
  const data = await page.evaluate(() => ({
    width: window.innerWidth,
    bodyClass: document.body.className,
    bodyStyle: document.body.getAttribute('style'),
    shell: Math.round(document.querySelector('.shell')?.getBoundingClientRect().width ?? -1),
    workspace: Math.round(document.querySelector('.workspace-switcher')?.getBoundingClientRect().width ?? -1),
    rail: Math.round(document.querySelector('.app-sidebar')?.getBoundingClientRect().width ?? -1),
  }))
  console.log(name, data)
}

await page.evaluate(() => window.engram.botCreate({ name: 'Research scout', purpose: 'runs web errands' }))
await page.evaluate(() => window.engram.botCreate({ name: 'ai', purpose: 'ai research' }))
await page.getByTestId('activity-bots').click()
await page.waitForTimeout(600)
await layout('comets-open')
await shot('comets-open')
await page.getByTestId('help-button').click()
await page.waitForTimeout(150)
await shot('help-sidebar')
await page.keyboard.press('Escape')
await page.locator('.bots-write textarea').fill('첫 줄\n둘째 줄\n셋째 줄')
await page.waitForTimeout(200)
await shot('comets-composer-3-lines')
await page.locator('.bots-write textarea').fill('')
await page.getByTestId('bots-memory-toggle').click()
await page.waitForTimeout(180)
await shot('comets-memory')
await page.getByTestId('bots-memory-toggle').click()
await page.getByTestId('app-sidebar-close').click()
await page.waitForTimeout(500)
await shot('comets-folded')
if (await page.getByTestId('model-picker').count()) {
  await page.getByTestId('model-picker').click()
  await page.waitForTimeout(150)
  await shot('model-picker')
  await page.keyboard.press('Escape')
}
await page.getByTestId('composer-web').click()
await page.waitForTimeout(300)
await shot('web-wide')
await page.setViewportSize({ width: 948, height: 760 })
await page.getByTestId('app-sidebar-open').click()
await page.getByTestId('web-pane').evaluate((element) => element.setAttribute('style', '--web-pane-width: 1200px'))
await page.waitForTimeout(250)
await shot('web-compact-sidebar')
await page.getByTestId('app-sidebar-close').click()
await page.setViewportSize({ width: 900, height: 720 })
await page.waitForTimeout(250)
await shot('web-medium')
await page.setViewportSize({ width: 620, height: 720 })
await page.waitForTimeout(250)
await shot('web-narrow')
await page.getByTestId('web-pane-fold').click()
await page.waitForTimeout(500)
console.log('narrow-folded', await page.evaluate(() => ({
  head: document.querySelector('.bots-head')?.textContent,
  headBox: document.querySelector('.bots-head')?.getBoundingClientRect().toJSON(),
  pane: Boolean(document.querySelector('.web-pane')),
  notice: document.querySelector('.notices')?.textContent,
})))
await shot('comets-narrow')
await page.setViewportSize({ width: 1280, height: 840 })
await page.getByTestId('app-sidebar-open').click()
await page.waitForTimeout(250)
await page.getByTestId('activity-sky').click()
await page.waitForTimeout(800)
await shot('cosmos-open')
await page.getByTestId('cosmos-chat-collapse').click()
await page.waitForTimeout(500)
await shot('cosmos-folded')
await page.getByTestId('cosmos-chat-open').click()
await page.getByTestId('activity-list').click()
await page.waitForTimeout(600)
await shot('list')
await page.getByTestId('list-row').first().click()
await page.waitForTimeout(500)
await shot('note-sheet')
await page.keyboard.press('Escape')
await page.getByTestId('activity-settings').click()
await page.waitForTimeout(600)
await shot('settings')
await page.getByRole('button', { name: 'Diagnostics' }).click()
await page.getByTestId('diagnostics-view').waitFor({ state: 'visible' })
await page.waitForTimeout(500)
await shot('diagnostics')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.getByTestId('workspace-switcher').click()
await page.getByTestId('workspace-menu').waitFor({ state: 'visible' })
await shot('workspace-menu')
await page.getByRole('button', { name: 'New workspace…' }).click()
await page.waitForTimeout(200)
await shot('workspace-new')
await page.keyboard.press('Escape')
await page.getByTestId('workspace-switcher').click()
await page.getByTestId('workspace-github-backup').click()
await page.getByTestId('github-connect').waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await shot('github-connect')
await page.keyboard.press('Escape')
await page.keyboard.press('Control+Shift+P')
await page.getByTestId('palette-input').fill('scrap')
await page.keyboard.press('Enter')
await page.getByTestId('inbox-overlay').waitFor({ state: 'visible' })
await shot('inbox')
await page.keyboard.press('Escape')
await page.getByTestId('activity-bots').click()
await page.keyboard.press('Control+Shift+p')
await page.getByTestId('palette-input').fill('review')
await page.keyboard.press('Enter')
await page.waitForTimeout(500)
await shot('review-sheet')
await page.keyboard.press('Escape')
await page.keyboard.press('Control+Shift+P')
await page.waitForTimeout(300)
const palette = page.locator('[cmdk-root]')
if (await palette.count()) {
  await page.keyboard.type('routine')
  await page.waitForTimeout(300)
  await layout('palette')
  await shot('palette')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  await shot('routines-sheet')
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
await layout('palette-closed')
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(400)
await shot('comets-dark')
await app.close()
console.log('shots in', OUT)
process.exit(0)
