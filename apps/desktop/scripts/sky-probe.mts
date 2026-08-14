import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

interface Probe {
  frames: number
  solves: number
}

const VAULT = fileURLToPath(new URL('../../../tmp/sky-probe-vault/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
const ids: string[] = []
for (let i = 0; i < 24; i++) {
  const n = await createNote(paths, { body: `# Star ${i}\n\nA memory in the probe sky.` })
  ids.push(n.front.id)
}
await createNote(paths, { body: '# Probe hub\n\nThe centre.', type: 'hub', derived_from: ids.slice(0, 8) })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: VAULT,
    ENGRAM_USERDATA: join(VAULT, '..', 'sky-probe-userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_ENGINE: 'none',
  },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.locator('[data-node-id]').first().waitFor({ state: 'visible', timeout: 30_000 })
const read = () => page.evaluate(() => (window as unknown as { __engramSky: Probe }).__engramSky)

// Park the pointer off the sky, then let the finite timelines (entrance 320ms
// + stagger, ignite 2.4s, hub pulse 3.2s × 3) run themselves out.
await page.mouse.move(4, 4)
await page.waitForTimeout(12_000)
// Settled frames on disk, for the eye that has to sign off on parity.
const OUT = fileURLToPath(new URL('../../../tmp/sky-probe/', import.meta.url))
await mkdir(OUT, { recursive: true })
await page.screenshot({ path: join(OUT, 'settled.png') })
const hub = page.locator('[data-node-id][aria-label="Probe hub"]')
await hub.hover()
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'hover.png') })
// Zoom in and back out: member titles must ramp in by degree order rather than
// arrive as a wall, and the round trip must not leave the labels flickering at
// a tier boundary (that is what the hysteresis is for).
const box = (await page.getByTestId('brain-graph').boundingBox())!
const corner = { x: box.x + 6, y: box.y + box.height - 6 }
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -240)
await page.mouse.move(corner.x, corner.y)
await page.waitForTimeout(700)
await page.screenshot({ path: join(OUT, 'zoomed.png') })
await page.mouse.dblclick(corner.x, corner.y)
await page.waitForTimeout(700)

// Then stress the newest timeline: in and out, repeatedly, right before the
// idle window. A tween that forgets to end shows up here or nowhere.
for (let i = 0; i < 3; i++) {
  await hub.hover()
  await page.waitForTimeout(120)
  await page.mouse.move(4, 4)
  await page.waitForTimeout(120)
}
await page.mouse.move(4, 4)
await page.waitForTimeout(600)
const settled = await read()
await page.waitForTimeout(3_000)
const idle = await read()
const idlePerSecond = (idle.frames - settled.frames) / 3
console.log(`idle frames: ${settled.frames} → ${idle.frames}  (${idlePerSecond.toFixed(2)}/s)`)

// A frontmatter-only write is the shape of nearly every sweep write: the
// dressing (here a recall halo) must go live, the solved sky must not move.
const before = await read()
const file = join(paths.notes, `${ids[0]}.md`)
const raw = await readFile(file, 'utf8')
await writeFile(file, raw.replace(/^updated: (.*)$/m, `updated: $1\nlast_recalled: ${new Date().toISOString()}`), 'utf8')
await page.waitForTimeout(4_000)
const after = await read()
console.log(`frontmatter delta → solves: ${before.solves} → ${after.solves}, frames +${after.frames - before.frames}`)

await app.close()
const failures: string[] = []
if (idlePerSecond > 0) failures.push(`idle frames must be 0/s, measured ${idlePerSecond.toFixed(2)}/s`)
if (after.solves !== before.solves) failures.push(`a frontmatter delta re-solved (${before.solves} → ${after.solves})`)
if (failures.length > 0) {
  for (const f of failures) console.error('FAIL:', f)
  process.exit(1)
}
console.log('sky-probe: idle is free and the shape memo holds')
