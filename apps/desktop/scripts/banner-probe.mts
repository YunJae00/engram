// Does the connect banner stay inside the window, and does the canvas stay put?
// The bug was an unstyled div in normal flow: it ran off the right edge and
// pushed the star field left. Numbers, at several window widths.
import { _electron as electron } from '@playwright/test'
import { initVault, createNote } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'banner-'))
const paths = await initVault(root, { git: false })
// A few stars, so the canvas has something whose position can shift.
for (let i = 0; i < 6; i += 1) {
  await createNote(paths, { id: `n-star-${i}`, body: `# Star ${i}\n\nbody` })
}

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
await page.getByTestId('connect-banner').waitFor({ state: 'visible', timeout: 60_000 })

for (const width of [1274, 1000, 820]) {
  // Resize the REAL window, not just the viewport: the top bar is sized by
  // env(titlebar-area-width), which only tracks actual window geometry. A
  // viewport-only resize leaves that env value stale and invents an overflow
  // that no user can produce.
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setSize(w, 800), width)
  await page.waitForTimeout(900)
  const m = await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="connect-banner"]') as HTMLElement
    const canvas = document.querySelector('[data-testid="sky-view"]') as HTMLElement
    const b = banner.getBoundingClientRect()
    const c = canvas?.getBoundingClientRect()
    return {
      bannerLeft: Math.round(b.left),
      bannerRight: Math.round(b.right),
      bannerBottom: Math.round(b.bottom),
      canvasLeft: Math.round(c?.left ?? -1),
      canvasWidth: Math.round(c?.width ?? -1),
      docScrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
      position: getComputedStyle(banner).position,
    }
  })
  const overflowsRight = m.bannerRight > m.viewportW
  const pushesPage = m.docScrollW > m.viewportW
  console.log(
    `${String(width).padStart(4)}px  banner ${m.bannerLeft}–${m.bannerRight} (${m.position})  ` +
      `canvas x=${m.canvasLeft} w=${m.canvasWidth}  ` +
      `${overflowsRight ? 'OVERFLOWS' : 'inside'}  ${pushesPage ? 'PAGE SCROLLS' : 'no h-scroll'}`,
  )
}


// Who is actually wider than the window?
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 800))
await page.waitForTimeout(400)
const wide = await page.evaluate(() => {
  const out = []
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth + 1 || r.left < -1) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 42)) || '',
        testid: el.getAttribute('data-testid') || '',
        left: Math.round(r.left), right: Math.round(r.right),
      })
    }
  }
  return out.slice(0, 12)
})
console.log('\nwider than the 900px window:')
for (const w of wide) console.log(`  ${w.tag}.${w.cls} [${w.testid}] ${w.left}-${w.right}`)

// It must not sit on top of the Today dock either.
const clash = await page.evaluate(() => {
  const b = document.querySelector('[data-testid="connect-banner"]')!.getBoundingClientRect()
  const t = document.querySelector('[data-testid="today-button"]')?.getBoundingClientRect()
  if (!t) return 'no today button'
  const overlap = !(b.right < t.left || b.left > t.right || b.bottom < t.top || b.top > t.bottom)
  return overlap ? 'OVERLAPS Today' : 'clear of Today'
})
console.log('\n' + clash)

await app.close()
