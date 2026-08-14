// Dogfood evaluation phase 1: live-capture notes (echo check), run Tidy with
// the REAL claude engine until the vault converges, then collect evidence —
// screenshots, review-card dumps, board/brain/brief states.
// Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/eval-drive.mts
import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/eval-vault/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/eval-shots/', import.meta.url))

const CAPTURES = [
  'bge-m3 임베딩 배치 크기를 32로 올렸더니 인덱싱이 2배 빨라졌다. 메모리는 4GB 정도 더 씀.',
  '다음 주 화요일 회의: RAG 평가 지표 리뷰. recall@5 말고 MRR도 볼지 결정해야 함.',
  'topN 동적화 배포 이후 recall@5가 0.74에서 0.82로 올라갔다.',
]

// Rapid burst: five distinct facts submitted back-to-back with no settle —
// stresses the J1 claim-first rename (capture pipeline vs auto-tidy drain
// race that used to turn 1 capture into 3 notes). Expect exactly 5 notes.
const RAPID_CAPTURES = [
  'PR 리뷰는 24시간 안에 첫 리스폰스를 주기로 팀 합의함.',
  '모니터 발주 완료 — 27인치 4K, 다음 주 수요일 도착 예정.',
  'pgvector 인덱스를 IVFFlat에서 HNSW로 바꾸는 것 검토 중. 빌드 시간이 문제.',
  '점심 스터디 7월 주제는 분산 트레이싱으로 정함. 교재는 OpenTelemetry 공식 문서.',
  '노션 데이터 이전 백업 완료. 원본 워크스페이스는 8월 말까지 보관 후 삭제.',
]

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: VAULT,
      ENGRAM_USERDATA: join(VAULT, '.userdata'),
      ENGRAM_NO_GIT: '1',
      // ENGRAM_ENGINE unset → auto → real claude CLI
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text().slice(0, 200))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2500)

  const shot = async (name: string) => {
    try {
      await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 30_000 })
      console.log('shot:', name)
    } catch (err) {
      console.error('shot FAILED:', name, String(err).slice(0, 120))
    }
  }

  // engine check
  const engineLabel = await page.getByTestId('engine-status').textContent()
  console.log('engine-status:', engineLabel?.trim())
  await shot('01-board-initial')

  // Capture and chat share one panel now — the launcher is only on screen
  // while it rests, so opening is a no-op once the panel is up.
  const openComposer = async () => {
    const launcher = page.getByTestId('remember-button')
    if (await launcher.count()) await launcher.click()
  }

  // ── live captures via composer ──
  for (const [i, text] of CAPTURES.entries()) {
    await openComposer()
    await page.getByTestId('chat-input').fill(text)
    await page.waitForTimeout(1200) // echo debounce + lookup
    const echo = page.getByTestId('capture-echo')
    if (await echo.count()) {
      const rows = await echo.locator('.echo-row').allTextContents()
      console.log(`echo[${i}]:`, JSON.stringify(rows))
      if (i === 0) await shot('02-capture-echo')
    } else {
      console.log(`echo[${i}]: (none)`)
    }
    await page.getByTestId('capture-submit').click()
    await page.waitForTimeout(800)
  }
  // ── rapid burst: no settle between submits ──
  for (const text of RAPID_CAPTURES) {
    await openComposer()
    await page.getByTestId('chat-input').fill(text)
    await page.getByTestId('capture-submit').click()
    await page.waitForTimeout(120)
  }
  console.log('rapid burst: 5 captures submitted', new Date().toISOString())
  await shot('03-after-captures')

  // ── tidy rounds until convergence ──
  const sweepBtn = page.getByTestId('sweep-button')
  const status = page.getByTestId('sweep-status')
  for (let round = 1; round <= 5; round++) {
    // wait until idle before (re)starting
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="sweep-button"]') as HTMLButtonElement)?.disabled,
      undefined,
      { timeout: 20 * 60_000 },
    )
    const badge = await sweepBtn.locator('.badge').textContent().catch(() => null)
    console.log(`round ${round}: unswept badge =`, badge ?? '0')
    if (round > 1 && (badge === null || badge === '0')) break
    await sweepBtn.click()
    console.log(`round ${round}: tidy started`, new Date().toISOString())
    // log progress while running
    const start = Date.now()
    for (;;) {
      await page.waitForTimeout(5000)
      const running = await page.evaluate(
        () => (document.querySelector('[data-testid="sweep-button"]') as HTMLButtonElement)?.disabled,
      )
      const label = (await status.textContent().catch(() => ''))?.trim()
      if (label) console.log(`  [${Math.round((Date.now() - start) / 1000)}s]`, label)
      if (!running) break
      if (Date.now() - start > 20 * 60_000) {
        console.error('  tidy round timed out at 20min')
        break
      }
    }
    console.log(`round ${round}: tidy done in ${Math.round((Date.now() - start) / 1000)}s`)
    await page.waitForTimeout(3000)
  }
  await shot('04-board-after-tidy')

  if ((await page.getByTestId('today-sheet').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }

  // ── review cards dump ──
  const reviewBadge = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => '0')
  console.log('review pending:', reviewBadge)
  if (reviewBadge && reviewBadge !== '0') {
    await page.getByTestId('review-count').click()
    await page.getByTestId('review-sheet').waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(800)
    await shot('05-review-sheet')
    // dump every card by stepping through the stack (approve/reject buttons present)
    const detail = page.getByTestId('review-detail')
    for (let i = 0; i < 30; i++) {
      if (!(await detail.count())) break
      const text = await detail.textContent()
      console.log(`--- card ${i + 1} ---`)
      console.log(text?.replace(/\s+/g, ' ').trim().slice(0, 900))
      await shot(`05-card-${String(i + 1).padStart(2, '0')}`)
      // skip without deciding: look for a "later/skip/next" control; otherwise stop
      const skip = page
        .getByTestId('review-sheet')
        .getByRole('button', { name: /later|skip|next|나중|다음/i })
        .first()
      if (await skip.count()) {
        await skip.click()
        await page.waitForTimeout(500)
      } else {
        console.log('(no skip control — stopping card walk to avoid deciding)')
        break
      }
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // ── brain view ──
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(1500)
  await shot('06-brain')
  const topics = await page.getByTestId('brain-topic').allTextContents().catch(() => [])
  console.log('brain topics:', JSON.stringify(topics))
  const synthesis = await page.getByTestId('brain-synthesis').allTextContents().catch(() => [])
  console.log('brain synthesis:', JSON.stringify(synthesis).slice(0, 1500))

  // ── today brief ──
  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(500)
  await page.getByTestId('today-button').click()
  await page.getByTestId('today-sheet').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await shot('07-today-brief')
  const brief = await page.getByTestId('today-sheet').textContent()
  console.log('brief:', brief?.replace(/\s+/g, ' ').trim().slice(0, 1200))

  await app.close()
  console.log('phase 1 complete')
}

void main()
