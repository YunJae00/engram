import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../tmp/visual/rd-tone-screens-finish/', import.meta.url))
const INK = 'rgb(28, 27, 25)', USER_BUBBLE = 'rgb(239, 235, 230)', SURFACE = 'rgb(252, 250, 247)', CANVAS = 'rgb(246, 243, 238)', DANGER = 'rgb(166, 61, 47)'
const LAST = '로컬 데스크톱 에이전트는 이미 로그인된 환경을 그대로 쓸 수 있어요.'
const DRAFT = '레이아웃을 바꿔도 남아 있어야 하는 초안'

type Box = { left: number; top: number; right: number; bottom: number }
const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1

test('cream+ink screen finish and empty state', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'tone-screens-'))
  const userData = await mkdtemp(join(TMP, 'tone-screens-user-'))
  let app: ElectronApplication | undefined
  try {
    const paths = await initVault(vault, { git: false })
    app = await electron.launch({
      args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    const start = Date.now() - 3_600_000
    const chat = await createBot(paths, { name: '뉴스 정리' }, new Date(start))
    const turns: Array<[role: 'user' | 'assistant', text: string]> = [['user', '이번 주 AI 에이전트 뉴스 정리해줘'], ['assistant', '이번 주 주요 소식 세 가지예요.'], ['user', '2번 좀 더 자세히'], ['assistant', LAST]]
    for (const [index, [role, text]] of turns.entries()) await appendBotTurn(paths, chat.id, { role, text, at: new Date(start + index * 60_000).toISOString() })
    const failing = await createBot(paths, { name: '오류 대화' }, new Date(start + 1000))
    await appendBotTurn(paths, failing.id, { role: 'user', text: '요약해줘', at: new Date(start + 600_000).toISOString() })
    await appendBotTurn(paths, failing.id, { role: 'assistant', text: '[codex] {"type":"error","error":{"message":"The service is busy right now."}}', at: new Date(start + 660_000).toISOString() })
    const plain = await createBot(paths, { name: '빈 대화' }, new Date(start + 2000))
    const research = await createBot(paths, { name: '리서치' }, new Date(start + 3000))
    await page.evaluate(id => window.engram.botUpdate(id, { label: '자료 조사', templateId: 'research' }), research.id)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1360, 860))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1360, 860])
    const shot = async (name: string) => {
      const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
      await writeFile(join(SHOTS, name), Buffer.from(png, 'base64'))
    }
    const open = async (id: string) => {
      const row = page.getByTestId(`bot-${id}`), earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
    }

    await openActivity(page, 'bots')
    await open(chat.id)
    const thread = page.locator('.bots-thread')
    await expect(thread).toContainText(LAST)
    await shot('sidebar-chat-input.png')
    const bubbles = await page.evaluate(() => {
      const view = document.querySelector('.bots-thread')!.getBoundingClientRect()
      const read = (node: Element) => { const style = getComputedStyle(node), box = node.getBoundingClientRect(); return { background: style.backgroundColor, color: style.color, radius: style.borderTopLeftRadius, leftGap: box.left - view.left, rightGap: view.right - box.right } }
      return { user: [...document.querySelectorAll('.bots-thread .bubble-msg.user')].map(read), assistant: [...document.querySelectorAll('.bots-thread .bubble-msg.assistant')].map(read) }
    })
    expect(bubbles.user.length).toBe(2)
    expect(bubbles.assistant.length).toBe(2)
    for (const one of bubbles.user) {
      expect(one).toMatchObject({ background: USER_BUBBLE, color: INK, radius: '18px' })
      expect(one.rightGap, 'user bubbles sit on the right').toBeLessThan(one.leftGap)
    }
    for (const one of bubbles.assistant) {
      expect(one, 'assistant text is an unbubbled ink body').toMatchObject({ background: 'rgba(0, 0, 0, 0)', color: INK })
      expect(one.leftGap, 'assistant text sits on the left').toBeLessThan(one.rightGap)
    }

    const size = { width: 1280, height: 720 }
    const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toPNG().toString('base64'), size)
    const lane = `bot-${chat.id}`
    await app.evaluate(({ BrowserWindow }, events) => {
      const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
      for (const event of events) window.webContents.send('engram:event', event)
    }, [{ type: 'comet:working', channel: lane, working: true }, { type: 'comet:step', channel: lane, line: 'read_open_page: news.example.com' }, { type: 'agent:live', on: true, url: 'https://news.example.com/', lane }, { type: 'agent:frame', lane, url: 'https://news.example.com/', data, ...size }])
    const card = page.locator('.bots-chat').getByTestId('preview-card')
    await expect(card).toBeVisible()
    await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const live = await page.evaluate(() => {
      const rect = (node: Element) => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
      const card = document.querySelector('.bots-chat [data-testid="preview-card"]')!
      const face = getComputedStyle(card.querySelector('.preview-card-caption')!, '::before')
      const composer = document.querySelector('[data-testid="bots-input"]')!.closest('.chat-write')!
      const last = [...document.querySelectorAll('.bots-thread .bubble-msg')].at(-1)!
      return { background: getComputedStyle(card).backgroundColor, shadow: getComputedStyle(card).boxShadow, face: { image: face.backgroundImage, width: face.width, height: face.height }, card: rect(card), composer: rect(composer), last: rect(last) }
    })
    expect(live.background).toBe(SURFACE)
    expect(live.shadow).toContain('rgba(28, 27, 25, 0.06)')
    expect(live.face.image).toContain('07-oval')
    expect(live.face).toMatchObject({ width: '20px', height: '20px' })
    const faceUrl = live.face.image.replace(/^url\("?|"?\)$/g, '')
    expect(await page.evaluate(url => fetch(url).then(response => response.ok && response.headers.get('content-type')?.includes('png')), faceUrl), 'the live-card face asset loads').toBe(true)
    expect(overlaps(live.card, live.composer), 'live card leaves the composer clear').toBe(false)
    expect(overlaps(live.card, live.last), 'live card leaves the last message clear').toBe(false)
    const deckMotion = await page.evaluate(() => {
      const deck = document.querySelector('.bots-chat .preview-deck-card[data-position="0"]')!, inner = getComputedStyle(deck.querySelector('.preview-card')!), style = getComputedStyle(deck)
      return { name: style.animationName, timing: style.transitionTimingFunction.split(', '), durations: style.transitionDuration.split(', ').map(parseFloat), cardDuration: parseFloat(inner.animationDuration), cardTiming: inner.animationTimingFunction }
    })
    expect(deckMotion.name, 'the deck has no overshoot animation').toBe('none')
    expect(deckMotion.timing.every(one => one === 'ease')).toBe(true)
    expect(deckMotion.durations.every(one => one >= 0.15 && one <= 0.2)).toBe(true)
    expect(deckMotion.cardDuration).toBeGreaterThanOrEqual(0.15)
    expect(deckMotion.cardDuration).toBeLessThanOrEqual(0.2)
    expect(deckMotion.cardTiming).toBe('ease')
    await shot('live-card.png')

    await open(failing.id)
    const error = page.locator('.bots-thread .bubble-msg.assistant.error')
    await expect(error).toBeVisible()
    const errorStyle = await error.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, heading: getComputedStyle(node.querySelector('.answer-error-heading')!).color }))
    expect(errorStyle).toEqual({ color: DANGER, background: USER_BUBBLE, heading: DANGER })
    await shot('error-card.png')

    const emptyState = async (id: string, line: string) => {
      await open(id)
      const empty = page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"]')
      await expect(empty).toBeVisible()
      const seen = await empty.evaluate(node => {
        const shown = (one: Element) => { const box = one.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(one).visibility !== 'hidden' }
        const texts = [...node.querySelectorAll('h2, p, button')].filter(shown)
        const avatar = node.querySelector('.bot-avatar')!.getBoundingClientRect()
        return { texts: texts.map(one => one.textContent), color: texts[0] && getComputedStyle(texts[0]).color, faces: [...node.querySelectorAll('.bot-avatar')].filter(shown).length, faceSize: avatar.width, lines: texts[0] ? Math.round(texts[0].getBoundingClientRect().height / parseFloat(getComputedStyle(texts[0]).lineHeight)) : 0 }
      })
      expect(seen.texts, 'one short line and no suggestion chips').toEqual([line])
      expect(seen).toMatchObject({ color: 'rgb(111, 107, 102)', faces: 1, lines: 1 })
      expect(seen.faceSize).toBeGreaterThanOrEqual(64)
      expect(seen.faceSize).toBeLessThanOrEqual(80)
      await expect(empty.getByTestId('bot-empty-chip').first()).toBeHidden()
    }
    await emptyState(plain.id, '빈 대화')
    await shot('empty-plain.png')
    await emptyState(research.id, '자료 조사')
    await shot('empty-research.png')

    await page.getByTestId('bots-title-pill').click()
    const pane = page.getByTestId('bot-info-pane')
    await expect(pane).toBeVisible()
    await expect(pane.getByRole('tab')).toHaveCount(0)
    expect(await pane.evaluate(node => getComputedStyle(node).animationTimingFunction)).toBe('ease')
    expect(await pane.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(SURFACE)
    const paneFace = (await pane.locator('.bot-avatar').first().boundingBox())!.width
    expect(Math.abs(paneFace - 48), 'the info pane face is 48px').toBeLessThanOrEqual(1)
    await shot('info-pane.png')
    await page.getByTestId('bots-title-pill').click()
    await expect(pane).toHaveCount(0)

    await openActivity(page, 'settings')
    const settings = page.locator('[data-testid="settings-view"]')
    await expect(settings).toBeVisible()
    await shot('settings.png')
    // Reading a probe never flips a real switch such as autostart, which changes OS login items.
    const toggleOn = await settings.evaluate(view => {
      const real = [...view.querySelectorAll<HTMLInputElement>('input.switch:checked')].find(one => one.getBoundingClientRect().width > 0)
      if (real) return getComputedStyle(real).backgroundColor
      const probe = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'switch', checked: true })
      view.append(probe)
      try { return getComputedStyle(probe).backgroundColor } finally { probe.remove() }
    })
    expect(toggleOn, 'a toggle that is on is ink').toBe(INK)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('engines:states')
      ipcMain.handle('engines:states', (_event, ids?: string[]) => (ids ?? ['claude', 'codex']).map(id => ({ id, installed: true, loggedIn: id === 'codex', conclusive: true })))
      ipcMain.removeHandler('engines:logins')
      ipcMain.handle('engines:logins', () => [{ id: 'claude', phase: 'connected', canOpen: false }])
      ipcMain.removeHandler('accounts:states')
      ipcMain.handle('accounts:states', () => [{ id: 'system', provider: 'codex', name: 'System account', selected: true, installed: true, loggedIn: true, conclusive: true, healthy: true }])
    })
    await page.getByTestId('settings-nav-ai').click()
    await settings.locator('button[aria-label*="ChatGPT"]').first().click()
    const accounts = page.locator('.account-profile-dialog')
    await expect(accounts).toBeVisible()
    expect(await accounts.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node.querySelector('h2')!).color])).toEqual([SURFACE, INK])
    await page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().endTime !== Infinity).map(one => one.finished.catch(() => undefined))).then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))))
    await shot('settings-dialog.png')
    await page.keyboard.press('Escape')
    await expect(accounts).toHaveCount(0)
    if (await settings.isVisible()) await settings.getByRole('button', { name: /^(Close settings|설정 닫기)$/ }).click()
    await expect(settings).toHaveCount(0)
    await openActivity(page, 'bots')

    const before = await page.evaluate(() => window.engram.botsList().then(list => list.length))
    await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
    await page.getByTestId('bots-new').click()
    const create = page.locator('[role="dialog"][data-testid="create-bot-dialog"]')
    await expect(create).toBeVisible()
    await page.getByTestId('create-bot-name').fill('새 봇')
    expect(await create.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node.querySelector('#create-bot-title')!).color, getComputedStyle(node.querySelector('[data-testid="create-bot-submit"]')!).backgroundColor])).toEqual([SURFACE, INK, INK])
    await page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().endTime !== Infinity).map(one => one.finished.catch(() => undefined))).then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))))
    await shot('create-bot-dialog.png')
    await page.keyboard.press('Escape')
    await expect(create).toHaveCount(0)
    expect(await page.evaluate(() => window.engram.botsList().then(list => list.length))).toBe(before)

    await open(chat.id)
    await page.getByTestId('bots-input').fill(DRAFT)
    const avatar = () => page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar').getAttribute('data-character')
    const character = await avatar()
    expect(character).toBeTruthy()
    const rowFace = page.locator(`[data-testid="bot-${chat.id}"] .sidebar-conversation-avatar > .bot-avatar`)
    const rowAvatar = async () => { await expect(rowFace).toBeVisible(); return rowFace.getAttribute('data-character') }
    expect(await rowAvatar()).toBe(character)
    const mini = page.getByTestId(`mini-chat-${chat.id}`).getByRole('textbox')
    await page.getByTestId('mission-layout-2').click()
    await expect(page.locator('.mission-tile')).toHaveCount(2)
    await expect(mini).toHaveValue(DRAFT)
    expect(await rowAvatar()).toBe(character)
    await page.getByTestId('mission-layout-4').click()
    await expect(page.locator('.mission-tile')).toHaveCount(4)
    await expect(mini).toHaveValue(DRAFT)
    expect(await rowAvatar()).toBe(character)
    const split = await page.evaluate(() => ({
      empty: [...document.querySelectorAll('.mission-tile-body')].map(node => getComputedStyle(node).backgroundColor),
      motion: getComputedStyle(document.querySelector('.mission-tile-body')!).transitionTimingFunction,
      duration: getComputedStyle(document.querySelector('.mission-tile-body')!).transitionDuration,
    }))
    for (const color of split.empty) expect(color, 'split tiles stay canvas, never black').toBe(CANVAS)
    expect(split.motion.split(', ').every(one => one === 'ease')).toBe(true)
    expect(split.duration.split(', ').every(one => one === '0s' || (parseFloat(one) >= 0.15 && parseFloat(one) <= 0.2))).toBe(true)
    await shot('split-4.png')
    await page.getByTestId('mission-layout-1').click()
    await expect(page.getByTestId('mission-control')).toHaveCount(0)
    await expect(page.getByTestId('bots-input')).toHaveValue(DRAFT)
    expect(await avatar()).toBe(character)
  } finally {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})

test('onboarding keeps the cream surface', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const userData = await mkdtemp(join(TMP, 'tone-onboard-user-'))
  const parent = await mkdtemp(join(TMP, 'tone-onboard-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      timeout: 90000,
      args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: userData, ENGRAM_ONBOARD_ROOT: join(parent, 'Engram'), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0' },
    })
    const page = await app.firstWindow({ timeout: 90000 })
    await expect(page.getByTestId('onboard-step-1')).toBeVisible({ timeout: 60000 })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    const shot = async (name: string) => {
      const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
      await writeFile(join(SHOTS, name), Buffer.from(png, 'base64'))
    }
    const surface = async (primary: string) => {
      const seen = await page.evaluate(primary => {
        const card = document.querySelector('.onboard-card')!, button = document.querySelector(`[data-testid="${primary}"]`)!
        return { image: getComputedStyle(card).backgroundImage, title: getComputedStyle(card.querySelector('h1')!).color, primary: getComputedStyle(button).backgroundColor }
      }, primary)
      expect(seen.image).toContain(SURFACE)
      expect(seen).toMatchObject({ title: INK, primary: INK })
    }
    await surface('onboard-next')
    const boxes = await page.evaluate(() => {
      const rect = (node: Element) => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
      const faces = [...document.querySelectorAll('.onboard-card .bot-avatar')].filter(one => one.getBoundingClientRect().width > 0 && getComputedStyle(one).visibility !== 'hidden').map(rect)
      return { faces, primary: rect(document.querySelector('.onboard-actions > .primary')!) }
    })
    for (const face of boxes.faces) expect(overlaps(face, boxes.primary), 'a face never sits on the primary button').toBe(false)
    await page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().endTime !== Infinity).map(one => one.finished.catch(() => undefined))).then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))))
    await shot('onboarding.png')
    await page.getByTestId('onboard-next').click()
    await expect(page.getByTestId('onboard-step-2')).toBeVisible()
    await surface('onboard-ai-next')
    await page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().endTime !== Infinity).map(one => one.finished.catch(() => undefined))).then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))))
    await shot('onboarding-connect.png')
  } finally {
    await closeTestApp(app)
    await rm(userData, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})
