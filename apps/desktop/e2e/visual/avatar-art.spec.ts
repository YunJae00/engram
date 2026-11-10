import { expect, test, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from '../navigation.js'
import { seedVisualVault } from './seed.js'
import { artGalleryHtml } from './avatar-gallery.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const OUT = join(TMP, 'visual')

test.describe('avatar art', () => {
  test.skip(process.env['ENGRAM_VISUAL'] !== '1', 'Opt-in visual harness: set ENGRAM_VISUAL=1')

  test('gallery fills its box and keeps eyes on the body', async () => {
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
          const cells = [...document.querySelectorAll<HTMLElement>('.art-rows .art-cell[data-size="96"]')]
          cells.forEach((cell, i) => {
            const name = `cell ${i} body ${cell.dataset['body']} palette ${cell.dataset['palette']}`
            const svg = cell.querySelector('svg')!
            const body = svg.querySelector<SVGGElement>('.bot-avatar-body')!
            const half = Number(body.getAttribute('stroke-width')) / 2
            const boxes = [...body.children].map(el => (el as SVGGraphicsElement).getBBox())
            const left = Math.min(...boxes.map(b => b.x)) - half, top = Math.min(...boxes.map(b => b.y)) - half
            const right = Math.max(...boxes.map(b => b.x + b.width)) + half, bottom = Math.max(...boxes.map(b => b.y + b.height)) + half
            if (Math.max(right - left, bottom - top) < 76) bad.push(`${name}: body spans ${Math.max(right - left, bottom - top).toFixed(1)} < 76`)
            if (left < -0.5 || top < -0.5 || right > 96.5 || bottom > 96.5) bad.push(`${name}: body box ${left.toFixed(1)},${top.toFixed(1)},${right.toFixed(1)},${bottom.toFixed(1)} leaves 0..96`)
            const ctm = svg.getScreenCTM()!
            for (const eye of svg.querySelectorAll<SVGEllipseElement>('.bot-avatar-eyes ellipse')) {
              const [cx, cy, rx, ry] = ['cx', 'cy', 'rx', 'ry'].map(a => Number(eye.getAttribute(a)))
              const angle = Number(/rotate\(([-\d.]+)/.exec(eye.getAttribute('transform') ?? '')?.[1] ?? 0) * Math.PI / 180
              const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
              const points = [[0, 0], [0.8 * rx!, 0], [-0.8 * rx!, 0], [0, 0.8 * ry!], [0, -0.8 * ry!]].map(([u, v]) => [cx! + u! * cos - v! * sin, cy! + u! * sin + v! * cos])
              for (const [x, y] of points) {
                const sx = ctm.a * x! + ctm.c * y! + ctm.e, sy = ctm.b * x! + ctm.d * y! + ctm.f
                if (!document.elementsFromPoint(sx, sy).some(el => el.parentNode === body)) bad.push(`${name}: eye point ${x!.toFixed(1)},${y!.toFixed(1)} is off the body`)
              }
            }
          })
          return cells.length ? bad : ['no 96px cells']
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
