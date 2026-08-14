// Dogfood evaluation phase 3: work through the review stack like a real
// user (Keep B on conflicts, approve merges/supersedes, retire stale),
// logging every card seen — then one more tidy and a final state dump.
// Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/eval-review.mts
import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/eval-vault/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/eval-shots/', import.meta.url))

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: VAULT,
      ENGRAM_USERDATA: join(VAULT, '.userdata'),
      ENGRAM_NO_GIT: '1',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2500)

  const badge0 = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => '0')
  console.log('review pending at start:', badge0)
  await page.getByTestId('review-count').click()
  await page.getByTestId('review-sheet').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)

  const detail = page.getByTestId('review-detail')
  for (let i = 0; i < 20; i++) {
    if (!(await detail.count())) break
    const text = ((await detail.textContent()) ?? '').replace(/\s+/g, ' ')
    const head = text.slice(0, 160)
    const t0 = Date.now()
    let action = ''
    const btn = (name: RegExp) => page.getByTestId('review-sheet').getByRole('button', { name }).first()
    if (text.startsWith('conflict')) {
      action = 'Keep B'
      await btn(/^Keep B$/).click()
    } else if (text.startsWith('stale')) {
      action = 'Retire'
      await btn(/^Retire$/).click()
    } else {
      action = 'Approve'
      await btn(/^Approve/).click()
    }
    console.log(`card ${i + 1}: [${action}] ${head}`)
    // wait for the stack to advance (detail content changes or empties)
    await page
      .waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="review-detail"]')
          return !el || (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160) !== prev
        },
        head,
        { timeout: 30_000 },
      )
      .catch(() => console.log('  (stack did not advance in 30s)'))
    console.log(`  action took ${Date.now() - t0}ms`)
    await page.waitForTimeout(400)
    // Sibling-dismissal evidence: one decision should drop the pending count
    // by MORE than 1 when twin cards target the same notes.
    const badgeNow = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => null)
    console.log(`  pending after decision: ${badgeNow ?? '0'}`)
  }
  const badge1 = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => null)
  console.log('review pending after decisions:', badge1 ?? '0')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(OUT, '09-after-review.png') })

  // ── tidy round 2 (post-approval) ──
  const sweepBtn = page.getByTestId('sweep-button')
  const unswept = await sweepBtn.locator('.badge').textContent().catch(() => null)
  console.log('unswept after approvals:', unswept ?? '0')
  await sweepBtn.click()
  console.log('tidy 2 started')
  const start = Date.now()
  for (;;) {
    await page.waitForTimeout(5000)
    const running = await page.evaluate(
      () => (document.querySelector('[data-testid="sweep-button"]') as HTMLButtonElement)?.disabled,
    )
    if (!running) break
    if (Date.now() - start > 20 * 60_000) break
  }
  console.log(`tidy 2 done in ${Math.round((Date.now() - start) / 1000)}s`)
  await page.waitForTimeout(3000)
  const badge2 = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => null)
  const unswept2 = await sweepBtn.locator('.badge').textContent().catch(() => null)
  console.log('after tidy 2 — review pending:', badge2 ?? '0', '· unswept:', unswept2 ?? '0')
  await page.screenshot({ path: join(OUT, '10-after-tidy2.png') })

  await app.close()
  console.log('phase 3 complete')
}

void main()
