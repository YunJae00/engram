import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp, openActivity } from './navigation.js'
import { appendBotTurn, initVault, type Bot } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let bots: Bot[]
let dirs: string[] = []

const TURNS: Record<string, [string, string][]> = {
  '리서치': [
    ['이번 주 AI 에이전트 관련 주요 뉴스 정리해줘', '이번 주 주요 소식 세 가지예요.\n1. 멀티 에이전트 오케스트레이션 도구가 늘었어요.\n2. 로컬 컴퓨터를 같이 쓰는 데스크톱 에이전트가 주목받고 있어요.\n3. 장기 기억(메모리) 기능이 기본 기능이 되는 추세예요.'],
    ['2번 좀 더 자세히', '로컬 데스크톱 에이전트는 사용자의 컴퓨터에서 앱과 브라우저를 직접 다뤄요. 클라우드 컴퓨터를 따로 주는 방식과 달리 이미 로그인된 환경을 그대로 쓸 수 있는 게 장점이에요.'],
    ['단점은 뭐야?', '권한 관리가 까다로워요. '.repeat(2) + '사용자가 무엇을 허락했는지 분명히 보여 줘야 해요.'],
    ['정리 고마워', '필요하면 출처 목록도 함께 정리해 드릴게요.'],
  ],
  '일정 비서': [
    ['내일 오전 회의 준비해줘', '내일 오전 10시 제품 회의 자료를 정리했어요. 안건은 릴리즈 일정, 사이드바 정리, 실시간 카드 레이아웃이에요.'],
    ['참석자는 누구야?', '제품, 디자인, 개발 담당자 세 명이에요.\n회의실은 3층 큰 방으로 잡아 두었어요.'],
    ['자료는 어디 있어?', '공유 폴더의 회의 자료 문서에 있어요. '.repeat(2) + '링크는 일정 메모에도 붙여 두었어요.'],
    ['고마워', '필요하면 회의 30분 전에 다시 알려드릴게요.'],
  ],
}

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-split-pixels-vault-')), data = await mkdtemp(join(TMP, 'e2e-split-pixels-data-'))
  dirs = [vault, data]
  const paths = await initVault(vault, { git: false })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  bots = await page.evaluate(async (names) => Promise.all(names.map((name) => window.engram.botCreate({ name, purpose: '' }))), Object.keys(TURNS)) as Bot[]
  const at = new Date().toISOString()
  for (const bot of bots) {
    for (const [question, answer] of TURNS[bot.name]!) {
      await appendBotTurn(paths, bot.id, { role: 'user', text: question, at })
      await appendBotTurn(paths, bot.id, { role: 'assistant', text: answer, at })
    }
  }
  await page.evaluate((ids) => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map((bot) => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => {
  await closeTestApp(app)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function emit(events: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, events) => {
    const win = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('index.html'))!
    for (const event of events) win.webContents.send('engram:event', event)
  }, events)
}

async function settle(): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => undefined)))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

type Capture = { png: Buffer; bitmap: Buffer; width: number; height: number }

async function capture(): Promise<Capture> {
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes('index.html'))!
    // Wake a hidden window's compositor before capturing the current frame.
    await win.webContents.capturePage(undefined, { stayHidden: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const image = await win.webContents.capturePage(undefined, { stayHidden: true })
    const size = image.getSize()
    return { png: image.toPNG().toString('base64'), bitmap: image.toBitmap().toString('base64'), width: size.width, height: size.height }
  })
  return { png: Buffer.from(shot.png, 'base64'), bitmap: Buffer.from(shot.bitmap, 'base64'), width: shot.width, height: shot.height }
}

type Box = { left: number; top: number; right: number; bottom: number }
type Probe = { thread: Box; bubbles: Box[]; bubbleBg: number[]; width: number }

function probe(index: number): Promise<Probe> {
  return page.getByTestId(`mission-tile-${index}`).evaluate((tile) => {
    const rect = (node: Element): Box => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom } }
    const thread = rect(tile.querySelector('.mini-chat-thread')!)
    thread.bottom -= 24
    const sample = document.createElement('div')
    sample.style.background = 'var(--bubble-bg)'
    tile.append(sample)
    const bubbleBg = getComputedStyle(sample).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)
    sample.remove()
    const bubbles = [...tile.querySelectorAll('.mini-chat-thread .bubble-msg')].map(rect)
      .filter((box) => box.left >= thread.left && box.right <= thread.right && box.top >= thread.top && box.bottom <= thread.bottom)
    return { thread, bubbles, bubbleBg, width: innerWidth }
  })
}

function judge(shot: Capture, spot: Probe, label: string): void {
  const scale = shot.width / spot.width
  const px = (x: number, y: number): number[] => {
    const at = (y * shot.width + x) * 4
    return [shot.bitmap[at + 2]!, shot.bitmap[at + 1]!, shot.bitmap[at]!]
  }
  const diff = (a: number[], b: number[]) => Math.max(...a.map((value, channel) => Math.abs(value - b[channel]!)))
  const span = (box: Box) => ({
    x0: Math.max(0, Math.round(box.left * scale)), x1: Math.min(shot.width, Math.round(box.right * scale)),
    y0: Math.max(0, Math.round(box.top * scale)), y1: Math.min(shot.height, Math.round(box.bottom * scale)),
  })
  const area = span(spot.thread)
  let black = 0, total = 0
  for (let y = area.y0; y < area.y1; y++) {
    for (let x = area.x0; x < area.x1; x++) {
      total++
      if (Math.max(...px(x, y)) <= 12) black++
    }
  }
  expect(total, `SPLIT-PIXELS ${label} empty thread box`).toBeGreaterThan(0)
  expect(black / total, `SPLIT-PIXELS ${label} black=${black}/${total} (${(100 * black / total).toFixed(1)}%)`).toBeLessThan(0.05)
  expect(spot.bubbles.length, `SPLIT-PIXELS ${label} no bubble fully inside thread box`).toBeGreaterThan(0)
  spot.bubbles.forEach((bubble, k) => {
    const edge = px(Math.round((bubble.left + 6) * scale), Math.round((bubble.top + bubble.bottom) / 2 * scale))
    expect(diff(edge, spot.bubbleBg), `SPLIT-PIXELS ${label} bubble ${k} edge ${edge} vs --bubble-bg ${spot.bubbleBg}`).toBeLessThanOrEqual(8)
    const inside = span(bubble)
    let ink = 0
    for (let y = inside.y0; y < inside.y1; y++) for (let x = inside.x0; x < inside.x1; x++) if (diff(px(x, y), spot.bubbleBg) > 60) ink++
    expect(ink, `SPLIT-PIXELS ${label} bubble ${k} ink=${ink}`).toBeGreaterThanOrEqual(20)
  })
}

test('split view panes show their messages, not black voids', async () => {
  await openActivity(page, 'mission')
  await page.getByTestId('mission-layout-2').click()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  for (const index of [0, 1]) await expect(page.getByTestId(`mission-tile-${index}`).locator('.mission-name')).toHaveText(bots[index]!.name)

  for (const card of [false, true]) {
    if (card) {
      const lane = `bot-${bots[0]!.id}`
      const size = { width: 640, height: 400 }
      const frame = await app.evaluate(({ nativeImage }, size) => {
        const pixels = Buffer.alloc(size.width * size.height * 4)
        for (let i = 0; i < pixels.length; i += 4) pixels.set(i < pixels.length / 3 ? [72, 40, 24, 255] : [252, 250, 248, 255], i)
        return nativeImage.createFromBuffer(pixels, size).toDataURL()
      }, size)
      await emit([
        { type: 'comet:working', channel: lane, working: true },
        { type: 'desktop:preview', frames: [{ id: `${lane}:window:1`, lane, title: 'Split page', at: Date.now(), captureState: 'ready', current: true, data: frame }] },
      ])
      await expect(page.getByTestId('mission-tile-0').getByTestId('preview-card').locator('canvas[data-painted], img').first()).toBeVisible({ timeout: 20_000 })
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme)
      await settle()
      const spots = [await probe(0), await probe(1)]
      const shot = await capture()
      await test.info().attach(`split-${theme}-${card ? 'card' : 'nocard'}`, { body: shot.png, contentType: 'image/png' })
      for (const index of [0, 1]) {
        judge(shot, spots[index]!, `tile ${index} ${theme} card=${card}`)
        const textarea = page.getByTestId(`mission-tile-${index}`).locator('.mini-chat-write textarea')
        await expect(textarea).toBeVisible()
        await expect(textarea).toBeEditable()
      }
    }
  }
})
