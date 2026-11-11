import type { Page } from '@playwright/test'
import { deferred, near, type Check } from './spec.js'

type Box = { left: number; right: number; width: number; height: number } | null
export interface InfoPaneTools { probe(selector: string): Promise<Box>; shellOverflow(): Promise<number | null>; main: string; column: string; pill: string }

const PANE = '[data-testid="bot-info-pane"]'

async function until(ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40 && !await ok(); i++) await new Promise(done => setTimeout(done, 50))
}

export async function measureInfoPane(page: Page, { probe, shellOverflow, main, column, pill }: InfoPaneTools): Promise<Check[]> {
  const pane = page.locator(PANE)
  if (!await pane.isVisible()) return [deferred('row 15 info pane', '-', 'deferred: info pane is not open')]
  const box = await probe(PANE), view = await probe(main), avatar = await probe(`${PANE} .bot-info-overview .bot-avatar`), col = await probe(column)
  const checks = [
    near('info pane width', PANE, box?.width ?? null, 320, 2),
    near('info pane right edge offset', PANE, box && view ? box.right - view.right : null, 0, 2),
    near('overview avatar width', `${PANE} .bot-info-overview .bot-avatar`, avatar?.width ?? null, 96, 1),
    near('overview avatar height', `${PANE} .bot-info-overview .bot-avatar`, avatar?.height ?? null, 96, 1),
    near('chat column width', column, col?.width ?? null, view ? Math.min(960, view.width - 320 - 48) : 0, 2),
  ]
  await page.locator(pill).click()
  await until(async () => await pane.count() === 0)
  const after = await probe(column)
  checks.push(near('overflow after close', '[data-testid="shell"], [data-testid="shell"] *', await shellOverflow(), 0, 0),
    near('chat column width after close', column, after?.width ?? null, view ? Math.min(960, view.width - 48) : 0, 2))
  await page.locator(pill).click()
  await until(() => pane.isVisible())
  const line = '#bot-info-panel-files [data-testid="bot-info-empty"] p', overflowSelector = '[data-testid="shell"], [data-testid="shell"] *'
  await page.locator('#bot-info-tab-files').click({ timeout: 5000 }).catch(() => undefined)
  await until(() => page.locator(line).isVisible())
  if (await page.locator(line).isVisible()) {
    const size = await page.locator(line).evaluate(node => parseFloat(getComputedStyle(node).fontSize))
    checks.push(near('files empty line font size', line, Number.isFinite(size) ? size : null, 13, 0), near('files tab overflow', overflowSelector, await shellOverflow(), 0, 0))
  } else checks.push(near('files empty line font size', line, null, 13, 0), near('files tab overflow', overflowSelector, null, 0, 0))
  await page.locator('#bot-info-tab-overview').click({ timeout: 5000 }).catch(() => undefined)
  await until(async () => await page.locator('#bot-info-tab-overview').getAttribute('aria-selected') === 'true')
  return checks
}
