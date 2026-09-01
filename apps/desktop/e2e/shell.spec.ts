import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createCard, createNote, initVault, parseNote, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// M3 acceptance e2e: boot → temp vault, capture via UI → file lands, open a
// note, approve a seeded supersede card (A) → frontmatter changes, palette
// quick-open. Serial — one app instance for the whole flow.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths

// Reads a note's frontmatter, tolerating mid-write partial files on the slow
// filesystem — pollers retry instead of aborting on a parse error.
async function frontOf(id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(paths.notes, `${id}.md`), 'utf8')
    return parseNote(raw).front as unknown as Record<string, unknown>
  } catch {
    return null
  }
}

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-'))
  paths = await initVault(root, { git: false })
  // Seed: one plain note + a v1 note with a proposed supersede card.
  await createNote(paths, { id: 'n-hello-0001', body: '# Hello note\n\nThe very first note.' })
  await createNote(paths, { id: 'n-rule-0001', body: '# Deploy day\n\nWe deploy on Tuesdays.' })
  await createCard(paths, {
    cardType: 'supersede',
    targets: ['n-rule-0001'],
    rationale: 'Deploy day moved to Friday',
    proposed: '# Deploy day\n\nWe deploy on Fridays.',
  })
  await createNote(paths, {
    id: 'n-kick-0001',
    body: '# Kickoff\n\nProject kickoff meeting.',
    happened_at: '2026-02-01',
    timeline: 'pinned',
  })
  await createNote(paths, {
    id: 'n-ship-0001',
    body: '# First ship\n\nv0 went out.',
    happened_at: '2026-03-01',
    timeline: 'pinned',
  })
  await createNote(paths, { id: 'n-mid-0001', body: '# Midpoint check\n\nSomewhere between kickoff and ship.' })
  await createNote(paths, { id: 'n-ref-0001', body: '# Style guide\n\nTimeless reference material.' })
  // A linked cluster: three notes joined by derived_from, so the sky has a
  // constellation to draw.
  await createNote(paths, { id: 'n-argo-0001', body: '# Argo redesign\n\nThe umbrella decision.' })
  await createNote(paths, { id: 'n-argo-0002', body: '# Argo palette\n\nColor decisions.', derived_from: ['n-argo-0001'] })
  await createNote(paths, { id: 'n-argo-0003', body: '# Argo typography\n\nType decisions.', derived_from: ['n-argo-0001'] })
  // A written J10 digest, so the sheet it moved to renders the real thing
  // instead of only its empty line.
  await mkdir(paths.views, { recursive: true })
  await writeFile(join(paths.views, 'digest-2026-07-12.md'), '# Weekly digest\n\n## What accumulated\n\n- pricing notes.\n', 'utf8')

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  // Surface renderer crashes/errors directly in the test log.
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[renderer console.error]', msg.text())
  })
})

test.afterAll(async () => {
  await app?.close()
})

test('boots into the minimal shell on a temp vault', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('topbar')).toBeVisible()
  // Comets are home: the app opens on the work, and the sky is one tab over.
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('sky-view')).toBeVisible()
  // The seeded memories render as stars.
  await expect(page.getByTestId('brain-graph')).toBeVisible()
  // Asking (and keeping) is a docked panel on the cosmos's right edge.
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('no engine → connect banner shows', async () => {
  // ENGRAM_ENGINE=none: the librarian is offline, so the canvas carries the
  // connect nudge and Tidy wears the pending count (no sweep has ever run, so
  // every seeded note counts as not-yet-organized).
  const banner = page.getByTestId('connect-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Connect a brain' }).click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
})

test('workspace switcher shows the active workspace', async () => {
  // Registry is empty here (launched with ENGRAM_VAULT) — currentName falls back
  // to 'Engram' but the menu still renders the New/Join rows.
  await page.getByTestId('workspace-switcher').click()
  await expect(page.getByTestId('workspace-menu')).toBeVisible()
  await expect(page.getByTestId('workspace-menu')).toContainText('New workspace')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workspace-menu')).toHaveCount(0)
})

test('help panel opens with quick actions and legend', async () => {
  await page.getByTestId('help-button').click()
  const panel = page.getByTestId('help-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('How Engram works')
  await expect(panel).toContainText('Legend')
  // the Remember quick action focuses the cosmos chat box
  await panel.getByRole('button', { name: 'Remember' }).click()
  await expect(page.getByTestId('cosmos-chat-input')).toBeFocused()
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
})


test('the cosmos chat collapses and comes back', async () => {
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
  await page.getByTitle('Hide').click()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await page.getByTestId('cosmos-chat-open').click()
  await expect(page.getByTestId('cosmos-chat-input')).toBeVisible()
})

test('the comets rail folds away and returns', async () => {
  // A comet to fold beside: the strip is judged by what it keeps reachable.
  await page.evaluate(() => window.engram.botCreate({ name: 'Scout', purpose: 'finds things out' }))
  await page.getByTestId('activity-bots').click()
  // The strip remembers being folded, and this machine may carry that choice
  // from an earlier session: start from open, whatever it remembers.
  if (await page.getByTestId('comets-rail-open').count()) await page.getByTestId('comets-rail-open').click()
  await page.getByTestId('comets-rail-close').click()
  // Folded, the rail keeps a strip of its own: the reopen control lives INSIDE
  // the layout, so the thread beside it widens instead of hiding underneath a
  // floating button.
  await expect(page.getByTestId('comets-rail-folded')).toBeVisible()
  await expect(page.getByTestId('comets-rail-open')).toBeVisible()
  // Folded, every comet is still one click away as a chip, and the plus makes
  // a new one and opens the rail to show it, instead of dead-ending in the strip.
  const chip = page.locator('[data-testid^="bot-"]').first()
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(chip).toHaveClass(/active/)
  await page.getByTestId('bots-new').click()
  await expect(page.getByTestId('comets-rail-folded')).toHaveCount(0)
  await expect(page.locator('.bots-row.active')).toContainText('New comet')
  await page.getByTestId('comets-rail-close').click()
  await expect(page.getByTestId('comets-rail-open')).toBeVisible()
  await page.getByTestId('comets-rail-open').click()
  await expect(page.getByTestId('comets-rail-folded')).toHaveCount(0)
  await expect(page.getByTestId('bots-new')).toBeVisible()
  // A turned-down suggestion leaves the rail and does not return after a reload.
  const scout = page.getByTestId('bots-suggestion').filter({ hasText: 'Research scout' })
  await expect(scout).toBeVisible()
  await scout.getByTestId('bots-suggestion-dismiss').click()
  await expect(scout).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId('activity-bots').click()
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId('bots-suggestion').filter({ hasText: 'Research scout' })).toHaveCount(0)
  await page.getByTestId('activity-sky').click()
})

test('help hangs from the top bar, beside settings', async () => {
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
  await page.getByTestId('help-button').click()
  await expect(page.getByTestId('help-panel')).toBeVisible()
  // Escape closes it, and it is reachable from any tab because the bar is.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
  await page.getByTestId('activity-bots').click()
  await page.getByTestId('help-button').click()
  await expect(page.getByTestId('help-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('activity-sky').click()
})

test('the weekly digest reads on demand from the command palette', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('weekly digest')
  await expect(page.getByRole('option', { name: 'Read the weekly digest' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('digest-sheet')).toBeVisible()
  await expect(page.getByTestId('weekly-digest')).toContainText('pricing notes')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('digest-sheet')).toHaveCount(0)
})

test('Ctrl+L is the door to the comets tab', async () => {
  await page.keyboard.press('ControlOrMeta+l')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  // and the cosmos furniture stays off this tab
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('clicking a star in the cosmos opens the note sheet with editor and meta bar', async () => {
  // The sky is home — every seeded memory renders as a clickable star.
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.locator('[data-node-id="n-hello-0001"]').click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await expect(page.getByTestId('meta-bar')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('hovering a star lights its neighbours and lets the rest of the sky recede', async () => {
  // The sky exists to answer "what is this connected to". n-argo-0002 is
  // derived_from n-argo-0001, so that one burns with it; n-hello-0001 is a
  // stranger and dims. The canvas draws the alpha field; the ghosts carry the
  // settled state so a driver (and a screen reader) can read it.
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.locator('[data-node-id="n-argo-0002"]').hover()
  await expect(page.locator('[data-node-id="n-argo-0002"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-argo-0001"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-hello-0001"]')).toHaveAttribute('data-sky-state', 'dim')
  // Off the stars, the field lets go and the mirror clears with it.
  const box = (await page.getByTestId('brain-graph').boundingBox())!
  await page.mouse.move(box.x + 6, box.y + box.height - 6)
  await expect(page.locator('[data-node-id="n-argo-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
  await expect(page.locator('[data-node-id="n-hello-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
})

test('quick-open palette (Ctrl+P) opens a note', async () => {
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('Hello')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
})

test('drop zone round trip: dropped text lands in the inbox (scrap pile)', async () => {
  const before = (await readdir(paths.inbox)).filter((f) => f.endsWith('.md')).length
  // page.evaluate has none of the auto-waiting expect() has, so querySelector
  // ran against whatever was mounted at that instant and threw "Cannot read
  // properties of null" when the previous test's view was still settling.
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'dropped e2e memo')
    const target = document.querySelector('[data-testid="shell"]')!
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect
    .poll(async () => (await readdir(paths.inbox)).filter((f) => f.endsWith('.md')).length, { timeout: 20_000 })
    .toBe(before + 1)
  // the command palette's "Open scrap pile (inbox)" unfolds the overlay
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('scrap')
  await expect(page.getByRole('option', { name: 'Open scrap pile (inbox)' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inbox-list')).toContainText('dropped e2e memo')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox-overlay')).toHaveCount(0)
})

test('list view: rows render chronologically, the filter narrows them, a row opens the note sheet', async () => {
  await page.getByTestId('activity-list').click()
  await expect(page.getByTestId('list-view')).toBeVisible()
  // the seeded living notes show up as rows
  await expect.poll(() => page.getByTestId('list-row').count()).toBeGreaterThan(1)
  const before = await page.getByTestId('list-row').count()
  const dates = await page.locator('.list-date').allTextContents()
  expect(dates.length).toBeGreaterThan(1)
  expect([...dates].sort().reverse()).toEqual(dates)
  // a pinned anchor renders when it happened, not when it was last touched
  await expect(
    page.getByTestId('list-row').filter({ hasText: 'Kickoff' }).locator('.list-date'),
  ).toHaveText('2026-02-01')
  // filtering by a unique title stem shrinks the list to the one matching row
  await page.getByTestId('list-filter').fill('Hello')
  await expect.poll(() => page.getByTestId('list-row').count()).toBeLessThan(before)
  await expect(page.getByTestId('list-row')).toHaveCount(1)
  // clicking the row opens the shared note sheet
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('approving the seeded supersede card (A key) flips frontmatter', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('Open review')
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toContainText('Open review')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('review-sheet')).toBeVisible()
  await expect(page.getByTestId('review-detail')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await page.keyboard.press('a')
  await expect
    .poll(async () => (await frontOf('n-rule-0001'))?.['status'] ?? 'pending', { timeout: 20_000 })
    .toBe('superseded')
  // The replacement note exists and points back at the old one.
  const noteFiles = await readdir(paths.notes)
  let replacementFound = false
  for (const file of noteFiles) {
    const note = parseNote(await readFile(join(paths.notes, file), 'utf8'))
    if (note.front.supersedes.includes('n-rule-0001')) {
      replacementFound = true
      expect(note.body).toContain('Fridays')
    }
  }
  expect(replacementFound).toBe(true)
})
