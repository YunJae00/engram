// Dogfood evaluation phase 2: chat quality against the tidied eval vault.
// Q1 cross-note synthesis, Q2 freshness (stale vs current fact), Q3
// hallucination control (asks about something never recorded).
// Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/eval-chat.mts
import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/eval-vault/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/eval-shots/', import.meta.url))

// Default set: Q1 cross-note synthesis (+citations), Q2 freshness (must give
// the current fact, not the superseded one), Q3 hallucination control (never
// recorded — must say so). Override via CLI args for ad-hoc probes.
const DEFAULT_QUESTIONS = [
  '우리 RAG 검색 품질을 높이려고 지금까지 뭘 결정하고 확인했지? 근거 노트와 함께 정리해줘.',
  '파트너 API rate limit이 지금 분당 몇이지?',
  '우리 GraphQL 마이그레이션은 어떻게 하기로 결정했었지?',
]
const QUESTIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUESTIONS

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

  await page.keyboard.press('Control+l')
  await page.getByTestId('chat-panel').waitFor({ state: 'visible', timeout: 10_000 })

  for (const [i, q] of QUESTIONS.entries()) {
    console.log(`\n=== Q${i + 1}: ${q}`)
    const t0 = Date.now()
    await page.getByTestId('chat-input').fill(q)
    await page.getByTestId('chat-send').click()
    // wait for a NEW assistant bubble, then poll until its text is stable 6s
    const answer = page.locator('.chat-message.assistant').nth(i)
    await answer.waitFor({ state: 'visible', timeout: 60_000 })
    const firstTokenMs = Date.now() - t0
    let prev = ''
    let stableSince = Date.now()
    for (;;) {
      await page.waitForTimeout(1500)
      const cur = (await answer.textContent()) ?? ''
      if (cur !== prev) {
        prev = cur
        stableSince = Date.now()
      } else if (prev.trim().length > 10 && Date.now() - stableSince > 6000) break
      if (Date.now() - t0 > 4 * 60_000) {
        console.error('  (answer timed out at 4min)')
        break
      }
    }
    console.log(`  first token: ${firstTokenMs}ms · total: ${Date.now() - t0}ms`)
    console.log('  answer:', prev.replace(/\s+/g, ' ').trim().slice(0, 1500))
    const links = await answer.locator('a').allTextContents().catch(() => [])
    console.log('  cited notes:', JSON.stringify(links))
    const prefix = process.env.ENGRAM_EVAL_SHOT_PREFIX ?? '08-chat'
    await page.screenshot({ path: join(OUT, `${prefix}-q${i + 1}.png`) })
  }

  await app.close()
  console.log('\nphase 2 complete')
}

void main()
