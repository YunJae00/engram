import { expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({ apps: { outlook: true, excel: true, word: true, powerpoint: true } as unknown }))
vi.mock('electron', () => ({ screen: {} }))
vi.mock('../src/main/office-host.js', () => ({ officeApps: () => host.apps, officeSupported: () => true, officeRequest: vi.fn() }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: vi.fn() }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn(), officeWorkPreview: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: vi.fn() }))
vi.mock('../src/main/application-work.js', () => ({ applicationWork: vi.fn(), clearApplicationWork: vi.fn() }))
import { officeContext } from '../src/main/office-agent.js'
it('says a mail draft needs no recipient and the address is asked for at most once, never after promising a draft', () => {
  const text = officeContext()
  for (const part of ['mail commands only create drafts', 'A mail draft does not need a recipient', 'ask for the address once', 'Never say a recipient is required', 'never ask for an address after saying you will draft without one', 'On either path, put the full mail text you wrote in your reply']) expect(text).toContain(part)
})
it('stays empty when no office apps are available', () => {
  host.apps = null
  expect(officeContext()).toBe('')
})
