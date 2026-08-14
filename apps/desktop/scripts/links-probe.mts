import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

const VAULT = fileURLToPath(new URL('../../../tmp/links-probe-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/links-probe/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
const memberIds: string[] = []
for (let i = 0; i < 26; i++) {
  const n = await createNote(paths, { body: `# 멤버 노트 ${i} — 백엔드 작업 기록\n\n작업 ${i}의 상세 내용.` })
  memberIds.push(n.front.id)
}
await createNote(paths, {
  body: '# 허브 노트 링크 과부하 테스트\n\n스물여섯 개의 연결을 가진 허브.',
  type: 'hub',
  derived_from: memberIds,
})

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: join(VAULT, '..', 'links-probe-userdata'), ENGRAM_NO_GIT: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
// Window-first boot: the shell paints before the vault finishes reading —
// wait for the first star (notes actually loaded) before using the palette.
await page.locator('[data-node-id]').first().waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(500)
await page.keyboard.press('Control+p')
await page.getByTestId('palette-input').waitFor({ state: 'visible', timeout: 10_000 })
await page.getByTestId('palette-input').fill('허브')
// let the palette filter render its rows before committing
await page.waitForTimeout(600)
const { mkdir: mk } = await import('node:fs/promises')
await mk(OUT, { recursive: true })
await page.screenshot({ path: join(OUT, 'palette.png') })
await page.keyboard.press('Enter')
await page.getByTestId('note-sheet').waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
  await page.screenshot({ path: join(OUT, 'fail.png') })
  console.log('sheet did not open — see fail.png')
  await app.close()
  process.exit(1)
})
await page.waitForTimeout(600)
const panel = await page.getByTestId('links-panel').boundingBox()
const editor = await page.locator('.cm-host').boundingBox()
console.log('links-panel height:', panel?.height, '| editor visible height:', editor?.height)
const { mkdir } = await import('node:fs/promises')
await mkdir(OUT, { recursive: true })
await page.screenshot({ path: join(OUT, 'sheet.png') })
console.log('shot →', join(OUT, 'sheet.png'))
await app.close()
