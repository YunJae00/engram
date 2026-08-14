// Cold-start audit: a brand-new user's first 15 minutes on the REAL claude
// engine. Fresh home (no vault) → onboarding walk → empty shell → first
// capture → time-to-visible-change → chat on an empty vault → more captures
// (echo) → first Tidy. Every stage is screenshotted and timestamped so the
// "does the screen say what to do / did my action visibly land" questions
// can be judged from evidence.
// Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/coldstart-shots.mts
import { _electron as electron } from '@playwright/test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/coldstart-shots/', import.meta.url))
const HOME = join(REPO_TMP, 'coldstart-home')
const VAULT_PARENT = join(REPO_TMP, 'coldstart')
const VAULT = join(VAULT_PARENT, 'Engram')

// What a real first-time user might actually type (not dev notes).
const FIRST_CAPTURE = '금요일까지 연말정산 서류 제출해야 함'
const LATER_CAPTURES = [
  '이사 갈 집 조건: 역세권 10분 이내, 방 2개, 관리비 포함 90 이하',
  '팀장님이 다음 분기 목표는 신규 가입보다 리텐션이라고 함',
  '지난주에 산 원두는 산미가 너무 강했음. 다음엔 브라질 다크로',
  '운동은 화/목/토 아침으로 고정하기로 함',
]
const EMPTY_CHAT_Q = '지금 내 볼트에 뭐가 있어?'
const LATER_CHAT_Q = '내가 적어둔 것들 요약해줘'

const started = Date.now()
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`
const log = (...args: unknown[]) => console.log(stamp(), ...args)

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true })
  await rm(HOME, { recursive: true, force: true })
  await rm(VAULT_PARENT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await mkdir(HOME, { recursive: true })
  await mkdir(VAULT_PARENT, { recursive: true })

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: '', // no vault → onboarding must appear
      ENGRAM_USERDATA: HOME,
      ENGRAM_ONBOARD_ROOT: VAULT,
      ENGRAM_NO_GIT: '1',
      // ENGRAM_ENGINE unset → auto-detect → real claude CLI
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })

  const shot = async (name: string) => {
    try {
      await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 30_000 })
      log('shot:', name)
    } catch (err) {
      console.error(stamp(), 'shot FAILED:', name, String(err).slice(0, 120))
    }
  }

  // ── onboarding walk ──────────────────────────────────────────────
  await page.getByTestId('onboarding').waitFor({ state: 'visible', timeout: 30_000 })
  await shot('01-onboard-vault')
  await page.getByTestId('onboard-next').click()

  await page.getByTestId('onboard-step-2').waitFor({ state: 'visible' })
  await page.waitForTimeout(1200) // engine detection
  const lights = await page.locator('.engine-lights').textContent()
  log('onboard engines:', lights?.trim())
  await shot('02-onboard-ai')
  await page.getByTestId('onboard-next').click()

  await page.getByTestId('onboard-step-3').waitFor({ state: 'visible' })
  await shot('03-onboard-import')
  await page.getByTestId('onboard-skip-import').click()

  await page.getByTestId('onboard-step-4').waitFor({ state: 'visible' })
  await shot('04-onboard-team')
  await page.getByTestId('onboard-skip-team').click()

  await page.getByTestId('onboard-step-5').waitFor({ state: 'visible' })
  await shot('05-onboard-first-capture')
  await page.getByTestId('first-capture-input').fill(FIRST_CAPTURE)
  const tFinish = Date.now()
  await page.getByTestId('onboard-finish').click()
  log('onboarding finished, first capture submitted:', FIRST_CAPTURE)

  // ── land in the shell: what does a brand-new board say? ──────────
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
  const tShell = Date.now()
  log(`shell visible ${((tShell - tFinish) / 1000).toFixed(1)}s after finish`)
  await page.waitForTimeout(1500)
  await shot('10-board-first-look')
  log('starter visible:', await page.getByTestId('board-starter').count())
  log('scrap pile visible:', await page.getByTestId('scrap-pile').count())
  log('engine banner:', await page.getByTestId('engine-banner').count())
  log('engine status:', (await page.getByTestId('engine-status').textContent().catch(() => ''))?.trim())

  // ── chat on an (almost) empty vault ──────────────────────────────
  const askChat = async (q: string, name: string) => {
    await page.keyboard.press('Control+l')
    await page.getByTestId('chat-panel').waitFor({ state: 'visible', timeout: 10_000 })
    const before = await page.locator('.chat-message.assistant').count()
    const t0 = Date.now()
    await page.getByTestId('chat-input').fill(q)
    await page.getByTestId('chat-send').click()
    const answer = page.locator('.chat-message.assistant').nth(before)
    await answer.waitFor({ state: 'visible', timeout: 90_000 })
    log(`chat first token: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    let prev = ''
    let stableSince = Date.now()
    for (;;) {
      await page.waitForTimeout(1500)
      const cur = (await answer.textContent()) ?? ''
      if (cur !== prev) {
        prev = cur
        stableSince = Date.now()
      } else if (prev.trim().length > 10 && Date.now() - stableSince > 6000) break
      if (Date.now() - t0 > 3 * 60_000) {
        log('(chat timed out at 3min)')
        break
      }
    }
    log(`chat total: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    log('chat answer:', prev.replace(/\s+/g, ' ').trim().slice(0, 1200))
    await shot(name)
    await page.keyboard.press('Control+l') // close panel
    await page.waitForTimeout(400)
  }
  await askChat(EMPTY_CHAT_Q, '11-chat-empty-vault')

  // ── wait for the FIRST capture to become a visible note ──────────
  // (the pipeline has been running since onboarding finish; chat above ran
  // in parallel wall-clock — we report both raw and since-finish times)
  let firstNoteAt: number | null = null
  for (let i = 0; i < 360; i++) {
    const notes = await page.locator('[data-board-note]').count()
    if (notes > 0) {
      firstNoteAt = Date.now()
      break
    }
    await page.waitForTimeout(2000)
  }
  if (firstNoteAt) {
    log(`FIRST NOTE visible ${((firstNoteAt - tFinish) / 1000).toFixed(1)}s after onboarding finish`)
  } else {
    log('FIRST NOTE never appeared within 12min')
  }
  await page.waitForTimeout(500)
  await shot('12-first-note-visible')
  log('scrap pile now:', await page.getByTestId('scrap-pile').count())

  // ── later captures via composer: echo + time-to-note each ────────
  for (const [i, text] of LATER_CAPTURES.entries()) {
    // Capture and chat share one panel now — the launcher is only on screen
    // while it rests, so opening is a no-op once the panel is up.
    const launcher = page.getByTestId('remember-button')
    if (await launcher.count()) await launcher.click()
    await page.getByTestId('chat-input').fill(text)
    await page.waitForTimeout(1200) // echo debounce
    const echoRows = await page.locator('[data-testid="capture-echo"] .echo-row').allTextContents().catch(() => [])
    log(`echo[${i}]:`, JSON.stringify(echoRows))
    if (i === 0) await shot('13-capture-composer')
    const notesBefore = await page.locator('[data-board-note]').count()
    const t0 = Date.now()
    await page.getByTestId('capture-submit').click()
    // watch for visible change: note count up, or scrap pile change
    let landed: number | null = null
    for (let j = 0; j < 90; j++) {
      const notes = await page.locator('[data-board-note]').count()
      if (notes > notesBefore) {
        landed = Date.now()
        break
      }
      await page.waitForTimeout(2000)
    }
    log(
      `capture[${i}] "${text.slice(0, 24)}…" → ` +
        (landed ? `note visible in ${((landed - t0) / 1000).toFixed(1)}s` : 'NO visible note in 3min'),
    )
    if (i === 0) await shot('14-first-composer-capture-landed')
  }
  await shot('15-board-after-captures')

  // ── first Tidy ───────────────────────────────────────────────────
  // The auto-tidy (90s settle after the last capture) may already be running —
  // the librarian tidies WITHOUT the button. Ride it out first; click Tidy
  // manually only if pending work remains afterwards.
  const sweepBtn = page.getByTestId('sweep-button')
  const tTidy = Date.now()
  const waitForIdle = async () => {
    for (;;) {
      const running = await page.evaluate(
        () => (document.querySelector('[data-testid="sweep-button"]') as HTMLButtonElement)?.disabled,
      )
      const label = (await page.getByTestId('sweep-status').textContent().catch(() => ''))?.trim()
      if (label) log('  sweep:', label)
      if (!running) return
      if (Date.now() - tTidy > 15 * 60_000) {
        log('tidy timed out at 15min')
        return
      }
      await page.waitForTimeout(5000)
    }
  }
  const autoTidying = await page.evaluate(
    () => (document.querySelector('[data-testid="sweep-button"]') as HTMLButtonElement)?.disabled,
  )
  log('auto-tidy already running:', autoTidying)
  if (autoTidying) {
    await shot('16-tidy-running')
    await waitForIdle()
  }
  const badge = await sweepBtn.locator('.badge').textContent().catch(() => null)
  log('tidy badge after auto pass:', badge ?? '(none)')
  if (badge && badge !== '0') {
    await sweepBtn.click()
    await shot('16-tidy-running')
    await page.waitForTimeout(3000)
    await waitForIdle()
  }
  log(`first Tidy settled ${((Date.now() - tTidy) / 1000).toFixed(1)}s after check start`)
  await page.waitForTimeout(2000)
  await shot('17-board-after-tidy')

  // First-brief auto-reveal: the sheet may already be open (once-ever) — that
  // IS the "it organized my stuff" moment; record it, then continue via the
  // manual path so both routes are exercised.
  const autoOpened = (await page.getByTestId('today-sheet').count()) > 0
  log('today sheet auto-opened after first brief:', autoOpened)
  if (autoOpened) {
    await shot('17b-today-auto-reveal')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }

  const reviewBadge = await page.getByTestId('review-count').locator('.badge').textContent().catch(() => '0')
  log('review pending after first tidy:', reviewBadge)

  // Today brief — is there a "this is what got organized" moment?
  await page.getByTestId('today-button').click()
  await page.getByTestId('today-sheet').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await shot('18-today-brief')
  const brief = await page.getByTestId('today-sheet').textContent()
  log('brief:', brief?.replace(/\s+/g, ' ').trim().slice(0, 1000))
  await page.keyboard.press('Escape')

  // Brain view on a ~5-note vault
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(1200)
  await shot('19-brain')

  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(500)

  // ── chat again now that notes exist ──────────────────────────────
  await askChat(LATER_CHAT_Q, '20-chat-after-notes')

  await shot('21-final-board')

  // ── vault evidence ───────────────────────────────────────────────
  const notesDir = join(VAULT, 'workspace', 'notes')
  const notes = await readdir(notesDir).catch(() => [] as string[])
  log('vault notes on disk:', notes.length)
  for (const f of notes) log('  -', f)
  const inbox = await readdir(join(VAULT, 'workspace', 'inbox')).catch(() => [] as string[])
  log('inbox leftovers:', JSON.stringify(inbox))

  await app.close()
  log('cold-start audit complete →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
