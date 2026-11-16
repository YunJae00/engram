import type { Page } from '@playwright/test'
import { deferred, near, type Check } from './spec.js'

type Box = { left: number; right: number; width: number; height: number } | null
export interface InfoPaneTools { probe(selector: string): Promise<Box>; shellOverflow(): Promise<number | null>; main: string; column: string; pill: string }

const PANE = '[data-testid="bot-info-pane"]'

// The info pane and its title pill were removed: row 15 now holds that neither exists and the chat column keeps its full width.
export async function measureInfoPane(page: Page, { probe, shellOverflow, main, column, pill }: InfoPaneTools): Promise<Check[]> {
  const view = await probe(main), col = await probe(column)
  if (!col) return [deferred('row 15 info pane', '-', 'deferred: no chat is open')]
  return [
    near('info pane count', PANE, await page.locator(PANE).count(), 0, 0),
    near('title pill count', pill, await page.locator(pill).count(), 0, 0),
    near('chat view tabs', `${main} [role="tab"]`, await page.locator(`${main} [role="tab"]`).count(), 0, 0),
    near('chat column width', column, col.width, view ? Math.min(960, view.width - 48) : 0, 2),
    near('overflow without a pane', '[data-testid="shell"], [data-testid="shell"] *', await shellOverflow(), 0, 0),
  ]
}
