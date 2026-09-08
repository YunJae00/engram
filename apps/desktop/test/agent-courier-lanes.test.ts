import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCourier } from '../src/main/agent-courier.js'

const browser = vi.hoisted(() => ({
  ensureAgentPage: vi.fn(),
  agentPage: vi.fn(),
  readAgentPage: vi.fn(),
  armIdleClose: vi.fn(),
}))

vi.mock('../src/main/agent-browser.js', () => ({
  ...browser,
  DEFAULT_LANE: 'default',
  NAV_TIMEOUT_MS: 15000,
  agentAbortable: <T>(work: Promise<T>) => work,
}))
vi.mock('../src/main/agent-view.js', () => ({ touchedAt: () => 0 }))
vi.mock('../src/main/page-actions.js', () => ({
  chooseOption: vi.fn(), hoverOn: vi.fn(), pressKey: vi.fn(), pressOn: vi.fn(),
  pressPoint: vi.fn(), scrollPage: vi.fn(), typeText: vi.fn(),
}))
vi.mock('../src/main/page-reveal.js', () => ({ revealText: vi.fn() }))
vi.mock('../src/main/page-mask.js', () => ({ maskSecrets: vi.fn() }))
vi.mock('../src/main/page-ready.js', () => ({ readWhenReady: vi.fn() }))

function fixture() {
  const click = vi.fn().mockResolvedValue(undefined)
  const fill = vi.fn().mockResolvedValue(undefined)
  const match = { first: () => ({ click, fill }) }
  return {
    click,
    fill,
    page: {
      getByRole: vi.fn(() => match),
      getByLabel: vi.fn(() => match),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('courier legacy action lanes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    browser.readAgentPage.mockResolvedValue({ wall: undefined })
  })

  it('keeps concurrent typing and clicking inside their respective chat pages', async () => {
    const first = fixture()
    const second = fixture()
    const fallback = fixture()
    const pages = new Map([
      ['bot-first', first.page], ['bot-second', second.page], ['default', fallback.page],
    ])
    browser.ensureAgentPage.mockImplementation(async (lane: string) => pages.get(lane))
    browser.agentPage.mockImplementation(async (_signal: AbortSignal | undefined, lane = 'default') => pages.get(lane))
    const firstCourier = agentCourier({ lane: 'bot-first' })
    const secondCourier = agentCourier({ lane: 'bot-second' })
    const firstSignal = new AbortController().signal
    const secondSignal = new AbortController().signal

    expect(await Promise.all([
      firstCourier.typeInto!('First field', 'First value', firstSignal),
      secondCourier.typeInto!('Second field', 'Second value', secondSignal),
      firstCourier.clickOn!('First button', firstSignal),
      secondCourier.clickOn!('Second button', secondSignal),
    ])).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }])

    expect(first.page.getByLabel).toHaveBeenCalledWith('First field')
    expect(first.fill).toHaveBeenCalledExactlyOnceWith('First value', { timeout: 3000 })
    expect(first.page.getByRole).toHaveBeenCalledWith('button', { name: 'First button' })
    expect(first.click).toHaveBeenCalledTimes(1)
    expect(second.page.getByLabel).toHaveBeenCalledWith('Second field')
    expect(second.fill).toHaveBeenCalledExactlyOnceWith('Second value', { timeout: 3000 })
    expect(second.page.getByRole).toHaveBeenCalledWith('button', { name: 'Second button' })
    expect(second.click).toHaveBeenCalledTimes(1)
    expect(fallback.fill).not.toHaveBeenCalled()
    expect(fallback.click).not.toHaveBeenCalled()
    expect(browser.agentPage).toHaveBeenCalledWith(firstSignal, 'bot-first')
    expect(browser.agentPage).toHaveBeenCalledWith(secondSignal, 'bot-second')
    expect(browser.agentPage).toHaveBeenCalledTimes(4)
  })

  it('uses the default page when the courier has no explicit lane', async () => {
    const fallback = fixture()
    browser.ensureAgentPage.mockResolvedValue(fallback.page)
    browser.agentPage.mockResolvedValue(fallback.page)
    const courier = agentCourier()
    const signal = new AbortController().signal

    expect(await courier.typeInto!('Field', 'Value', signal)).toEqual({ ok: true })
    expect(await courier.clickOn!('Continue', signal)).toEqual({ ok: true })

    expect(browser.ensureAgentPage).toHaveBeenCalledWith('default')
    expect(browser.agentPage).toHaveBeenNthCalledWith(1, signal, 'default')
    expect(browser.agentPage).toHaveBeenNthCalledWith(2, signal, 'default')
    expect(fallback.fill).toHaveBeenCalledExactlyOnceWith('Value', { timeout: 3000 })
    expect(fallback.click).toHaveBeenCalledTimes(1)
  })
})
