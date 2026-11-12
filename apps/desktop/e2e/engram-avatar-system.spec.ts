import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initVault } from 'core'
import { characterIndex, CHARACTERS, defaultCharacter, resolveCharacter } from '../../../packages/core/src/bot-character.js'
import { closeTestApp } from './navigation.js'
import { seedVisualVault, CHAT_ID } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const PHOTO_ID = 'vis-photo'
const apps: ElectronApplication[] = []
const dirs: string[] = []

async function launch(): Promise<Page> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-avatar-system-')), profile = await mkdtemp(join(TMP, 'e2e-avatar-system-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  const { cache } = await initVault(vault, { git: false })
  const file = join(cache, 'bots.json')
  const stored = JSON.parse(await readFile(file, 'utf8')) as { bots: Record<string, unknown>[] }
  stored.bots.push({ id: PHOTO_ID, name: 'Old portrait', purpose: '', createdAt: '2026-01-05T09:00:00.000Z', avatar: { image: `bot-avatars/${PHOTO_ID}.png` } })
  await writeFile(file, JSON.stringify(stored))
  await mkdir(join(cache, 'bot-avatars'), { recursive: true })
  await writeFile(join(cache, 'bot-avatars', `${PHOTO_ID}.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  apps.push(app)
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  return page
}

const rowAvatar = (page: Page, id: string) => page.locator(`[data-testid="bot-${id}"] .sidebar-conversation-avatar > .bot-avatar`)
const list = (page: Page) => page.evaluate(() => window.engram.botsList())

async function sharp(avatar: Locator, px: number) {
  const m = await avatar.evaluate(node => {
    const img = node.querySelector('img')!
    const a = node.getBoundingClientRect(), b = img.getBoundingClientRect()
    let clipped = false
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el)
      if (s.overflow !== 'visible' && (b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5)) clipped = true
    }
    return { box: [a.width, a.height], img: [b.width, b.height], src: img.currentSrc, complete: img.complete, natural: img.naturalWidth, clipped, fit: getComputedStyle(img).objectFit }
  })
  expect(m.box).toEqual([px, px])
  expect(m.img).toEqual([px, px])
  expect(m.complete).toBe(true)
  expect(m.natural).toBeGreaterThanOrEqual(px * 2)
  expect(m.clipped).toBe(false)
  expect(m.fit).toBe('contain')
  return m.src
}

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('16-character assignment and picker', async () => {
  const page = await launch()

  // Old drawn and photo avatars show one of the 16, hashed from the real id, with no photo and no restore entry.
  for (const id of [CHAT_ID, 'vis-budget', PHOTO_ID]) {
    await expect(rowAvatar(page, id)).toHaveAttribute('data-character', defaultCharacter(id))
    expect(await rowAvatar(page, id).locator('img').getAttribute('src')).not.toMatch(/bot-avatars|blob:|data:/)
  }

  // Five new chats in a row: each face is the core rule applied to the real id, never repeating the one before.
  const before = (await list(page)).length
  for (let i = 0; i < 5; i++) await page.evaluate(n => window.engram.botCreate({ name: `Chat ${n}` }), i)
  const bots = await list(page)
  expect(bots.length).toBe(before + 5)
  const made = bots.slice(-5)
  for (let i = 0; i < made.length; i++) {
    const prev = bots[bots.length - 5 + i - 1]!
    const expected = defaultCharacter(made[i]!.id, characterIndex(resolveCharacter(prev.id, prev.avatar)))
    expect(made[i]!.avatar).toEqual({ character: expected })
    expect(expected).not.toBe(resolveCharacter(prev.id, prev.avatar))
    await expect(rowAvatar(page, made[i]!.id)).toHaveAttribute('data-character', expected)
  }

  // The same id keeps its face after a reload.
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  for (const bot of made) await expect(rowAvatar(page, bot.id)).toHaveAttribute('data-character', (bot.avatar as { character: string }).character)
  expect((await list(page)).slice(-5).map(b => b.avatar)).toEqual(made.map(b => b.avatar))

  // The sidebar row draws 24px from the @opt master, loaded, unclipped.
  const target = made[2]!
  expect(await sharp(rowAvatar(page, target.id), 24)).toMatch(/@opt[-.][^/]*png$/)

  // Picking in the 4x4 updates the sidebar and the 32px header immediately, with an ink ring.
  await page.getByTestId(`bot-${target.id}`).click()
  const header = page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar')
  await expect(header).toHaveAttribute('data-character', (target.avatar as { character: string }).character)
  expect(await sharp(header, 32)).not.toContain('@opt')
  await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
  const pane = page.getByTestId('bot-info-pane')
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('tab')).toHaveCount(0)
  await page.getByTestId('bot-info-avatar').click()
  const picker = pane.getByTestId('avatar-picker')
  await expect(picker.getByRole('radio')).toHaveCount(16)
  for (const id of CHARACTERS) await expect(picker.getByRole('radio', { name: id, exact: true })).toHaveCount(1)
  const choice = CHARACTERS.find(id => id !== (target.avatar as { character: string }).character)!
  await picker.getByRole('radio', { name: choice, exact: true }).click()
  await expect(rowAvatar(page, target.id)).toHaveAttribute('data-character', choice)
  await expect(header).toHaveAttribute('data-character', choice)
  await expect.poll(async () => (await list(page)).find(b => b.id === target.id)?.avatar).toEqual({ character: choice })
  const ring = await picker.locator('[aria-checked="true"]').evaluate(node => { const s = getComputedStyle(node); return [s.outlineWidth, s.outlineStyle, s.outlineColor] })
  expect(ring).toEqual(['2px', 'solid', 'rgb(28, 27, 25)'])

  // An old photo bot has no photo, no upload and no restore entry in its settings.
  await page.keyboard.press('Escape')
  await page.getByTestId(`bot-${PHOTO_ID}`).click()
  await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
  await expect(pane).toBeVisible()
  await expect(pane.locator('input[type="file"]')).toHaveCount(0)
  await expect(pane.getByText(/restore|photo|upload/i)).toHaveCount(0)
  await expect(pane.locator('img[src*="bot-avatars"], img[src^="blob:"]')).toHaveCount(0)
  await expect(pane.locator('[data-testid="bot-info-avatar"] .bot-avatar')).toHaveAttribute('data-character', defaultCharacter(PHOTO_ID))
})
