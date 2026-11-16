import { expect, test, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from '../navigation.js'
import { seedVisualVault } from './seed.js'
import { artGalleryHtml } from './avatar-gallery.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const OUT = join(TMP, 'visual', 'rd-avatar-system-v1')

test.describe('avatar art', () => {
  test.skip(process.env['ENGRAM_VISUAL'] !== '1', 'Opt-in visual harness: set ENGRAM_VISUAL=1')

  test('gallery shows all 8 orbs drawn at every size, the small still master up to 32px', async () => {
    await mkdir(OUT, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'avatar-art-vault-')), profile = await mkdtemp(join(TMP, 'avatar-art-profile-'))
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
    const app = await electron.launch({ args: [fileURLToPath(new URL('../../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    try {
      const page = await app.firstWindow()
      for (const theme of ['light', 'dark'] as const) {
        await page.setContent(await artGalleryHtml(theme))
        const file = join(OUT, `avatar-art-${theme}.png`)
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', scale: 'device' })
        console.log(file)
        const failures = await page.evaluate(() => {
          const bad: string[] = []
          const cells = [...document.querySelectorAll<HTMLElement>('.art-rows .art-cell')]
          for (const cell of cells) {
            const size = Number(cell.dataset['size'])
            const orb = cell.querySelector<HTMLElement>('.bot-orb')
            const name = `${cell.dataset['character']} ${size}`
            if (!orb || orb.dataset['orb'] !== cell.dataset['character'] || orb.querySelectorAll('svg').length !== 2 || cell.querySelector('canvas') || cell.querySelector('img')) { bad.push(`${name}: not an orb`); continue }
            const r = orb.getBoundingClientRect()
            if ((orb.dataset['motion'] === 'static') !== (size <= 32) || (orb.dataset['master'] === 'small') !== (size <= 32) || (orb.dataset['ripple'] === 'true') !== (size >= 64)) bad.push(`${name}: motion ${orb.dataset['motion']}`)
            if (Math.abs(r.width - size) > 0.5 || Math.abs(r.height - size) > 0.5) bad.push(`${name}: drawn ${r.width}x${r.height}`)
          }
          return cells.length === 8 * 7 ? bad : [`${cells.length} cells, not 56`]
        })
        expect(failures, theme).toEqual([])
      }
    } finally {
      await closeTestApp(app)
      await rm(vault, { recursive: true, force: true })
      await rm(profile, { recursive: true, force: true })
    }
  })
})
