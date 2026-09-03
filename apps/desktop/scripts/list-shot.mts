// The List tab with a few notes: does the table fill its slot?
import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
const VAULT = fileURLToPath(new URL('../../../tmp/list-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/list-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
for (const body of ['# Release cadence\n\nTuesdays.', '# Parser owner\n\nPlatform group.', '# Sky notes\n\nStars.']) await createNote(paths, { body })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await page.getByTestId('activity-list').click()
await page.waitForTimeout(900)
const width = await page.evaluate(() => {
  const view = document.querySelector('.list-view')?.getBoundingClientRect()
  return view ? `${Math.round(view.width)}px of ${innerWidth}px` : 'no list view'
})
console.log(`list view width: ${width}`)
console.log(await page.evaluate(() => {
  const view = document.querySelector('.list-view') as HTMLElement | null
  if (!view) return 'no view'
  const cs = getComputedStyle(view)
  const parent = view.parentElement!
  const pcs = getComputedStyle(parent)
  return `view flex:${cs.flex} · parent <${parent.tagName.toLowerCase()} class="${parent.className}"> display:${pcs.display} width:${Math.round(parent.getBoundingClientRect().width)}`
}))
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/list-shot.png', import.meta.url)) })
await app.close()
console.log('list-shot: DONE')
