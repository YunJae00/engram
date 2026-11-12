import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const FIRST = '이번 주 AI 에이전트 관련 주요 뉴스 정리해줘'
const TURNS: Array<[role: 'user' | 'assistant', text: string]> = [
  ['user', FIRST],
  ['assistant', '이번 주 주요 소식 세 가지예요.\n\n1. 멀티 에이전트 오케스트레이션 도구가 늘었어요.\n2. 로컬 컴퓨터를 같이 쓰는 데스크톱 에이전트가 주목받고 있어요.\n3. 장기 기억(메모리) 기능이 기본 기능이 되는 추세예요.'],
  ['user', '2번 좀 더 자세히'],
  ['assistant', '로컬 데스크톱 에이전트는 사용자의 컴퓨터에서 앱과 브라우저를 직접 다뤄요. 클라우드 컴퓨터를 따로 주는 방식과 달리 이미 로그인된 환경을 그대로 쓸 수 있는 게 장점이에요.'],
]
for (let index = 0; index < 8; index++) TURNS.push(['user', `관련 기사 링크도 ${index + 1}개 더 찾아서 출처와 함께 정리해줄 수 있어?`], ['assistant', `네, ${index + 1}번째 묶음을 정리했어요. 각 기사의 제목, 날짜, 핵심 문장을 함께 적었어요.`])

type Box = { left: number; top: number; right: number; bottom: number }
type Bubble = { text: string; box: Box; misses: string[] }

test('a live card covers no chat bubble', async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'live-card-cover-'))
  const userData = await mkdtemp(join(TMP, 'live-card-cover-user-'))
  let app: ElectronApplication | undefined
  try {
    const paths = await initVault(vault, { git: false })
    app = await electron.launch({
      args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    const bot = await createBot(paths, { name: '리서치' })
    const start = Date.now() - 3_600_000
    for (const [index, [role, text]] of TURNS.entries()) await appendBotTurn(paths, bot.id, { role, text, at: new Date(start + index * 60_000).toISOString() })
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1360, 860))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1360, 860])
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const thread = page.locator('.bots-thread')
    await expect(thread).toContainText(TURNS.at(-1)![1])

    const size = { width: 1280, height: 720 }
    const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toPNG().toString('base64'), size)
    const lane = `bot-${bot.id}`
    await app.evaluate(({ BrowserWindow }, events) => {
      const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
      for (const event of events) window.webContents.send('engram:event', event)
    }, [{ type: 'comet:working', channel: lane, working: true }, { type: 'comet:step', channel: lane, line: 'read_open_page: news.example.com' }, { type: 'agent:live', on: true, url: 'https://news.example.com/', lane }, { type: 'agent:frame', lane, url: 'https://news.example.com/', data, ...size }])
    const card = page.locator('.bots-chat').getByTestId('preview-card')
    await expect(card).toBeVisible()
    await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })

    const settle = () => page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined)))
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    })
    const inspect = () => page.evaluate(() => {
      const rect = (node: Element): Box => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
      const view = rect(document.querySelector('.bots-thread')!)
      const cards = [...document.querySelectorAll('.bots-chat > .live-overlay-deck, .bots-chat > .live-overlay-deck .preview-deck-card')]
        .filter(node => { const style = getComputedStyle(node), box = node.getBoundingClientRect(); return style.visibility !== 'hidden' && box.width > 0 && box.height > 0 })
        .map(rect)
      const bubbles: Bubble[] = [...document.querySelectorAll<HTMLElement>('.bots-thread .bubble-msg')].flatMap(node => {
        const box = rect(node)
        if (box.top < view.top || box.bottom > view.bottom || box.right - box.left < 1) return []
        const style = getComputedStyle(node)
        // Inner corners: the content box inset 4px, clear of the rounded border.
        const left = box.left + parseFloat(style.paddingLeft) + 4, right = box.right - parseFloat(style.paddingRight) - 4
        const top = box.top + parseFloat(style.paddingTop) + 4, bottom = box.bottom - parseFloat(style.paddingBottom) - 4
        const points = [[left, top], [right, top], [left, bottom], [right, bottom], [(box.left + box.right) / 2, (box.top + box.bottom) / 2]]
        const misses = points.filter(([x, y]) => !node.contains(document.elementFromPoint(x!, y!))).map(([x, y]) => `${Math.round(x!)},${Math.round(y!)} hits ${document.elementFromPoint(x!, y!)?.className ?? 'nothing'}`)
        return [{ text: (node.textContent ?? '').trim().slice(0, 40), box, misses }]
      })
      return { cards, bubbles }
    })
    const shot = async (name: string) => {
      const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
      await test.info().attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    }

    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
      for (const at of ['top', 'bottom']) {
        await thread.evaluate((node, at) => { node.scrollTop = at === 'top' ? 0 : node.scrollHeight }, at)
        await settle()
        const { cards, bubbles } = await inspect()
        await shot(`${theme}-${at}.png`)
        expect(cards.length, `${theme} ${at}: the live card is showing`).toBeGreaterThan(0)
        expect(bubbles.length, `${theme} ${at}: bubbles are in view`).toBeGreaterThan(0)
        if (at === 'top') expect(bubbles.some(one => one.text.startsWith(FIRST.slice(0, 10))), `${theme} top: the first message is checked`).toBe(true)
        const band = { top: Math.min(...cards.map(one => one.top)), bottom: Math.max(...cards.map(one => one.bottom)) }
        if (at === 'top') expect(bubbles.some(one => one.box.bottom > band.top && one.box.top < band.bottom), `${theme} top: a bubble sits in the card's band`).toBe(true)
        for (const bubble of bubbles) {
          for (const box of cards) {
            const width = Math.min(bubble.box.right, box.right) - Math.max(bubble.box.left, box.left)
            const height = Math.min(bubble.box.bottom, box.bottom) - Math.max(bubble.box.top, box.top)
            const overlap = width > 1 && height > 1
            expect(overlap, `COVERED ${theme} ${at}: "${bubble.text}" ${JSON.stringify(bubble.box)} overlaps card ${JSON.stringify(box)} by ${Math.round(width)}x${Math.round(height)}`).toBe(false)
          }
          expect(bubble.misses, `COVERED ${theme} ${at}: "${bubble.text}" ${JSON.stringify(bubble.box)} is not hit at its own points`).toEqual([])
        }
      }
    }
  } finally {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
