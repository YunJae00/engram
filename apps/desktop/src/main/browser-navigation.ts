import { lanePage, setViewHeight } from './agent-browser.js'

export async function browserHistory(lane: string): Promise<{ back: boolean; forward: boolean }> {
  const page = lanePage(lane)
  if (!page || page.isClosed()) return { back: false, forward: false }
  const session = await page.context().newCDPSession(page)
  try {
    const history = await session.send('Page.getNavigationHistory')
    return { back: history.currentIndex > 0, forward: history.currentIndex < history.entries.length - 1 }
  } finally { await session.detach() }
}

export async function browserNavigate(lane: string, direction: string): Promise<void> {
  if (!['back', 'forward', 'reload'].includes(direction)) throw new Error('Unknown navigation action')
  const page = lanePage(lane)
  if (!page || page.isClosed()) throw new Error('Open a website first')
  const options = { waitUntil: 'commit' as const, timeout: 15_000 }
  if (direction === 'reload') await page.reload(options)
  else if (direction === 'back') await page.goBack(options)
  else await page.goForward(options)
}

export async function browserResize(lane: string, width: number, height: number): Promise<void> {
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Invalid browser size')
  await setViewHeight(height, lane, width)
}
