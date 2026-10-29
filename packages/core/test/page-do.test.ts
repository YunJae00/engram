import { describe, expect, it, vi } from 'vitest'
import type { PageMove, WebCourier, WebPage } from '../src/errand.js'
import { pageControls, pageDoTool, pageOptions } from '../src/page-do.js'

const page = (controls: string[], text = 'Orders', url = 'https://shop.test/orders'): WebPage => ({ url, title: 'Orders', text, controls })
const picks = (...choices: string[]) => {
  const decide = vi.fn()
  for (const choice of choices) decide.mockResolvedValueOnce({ choice, confidence: 0.9, ms: 300 })
  return decide
}
const courier = (pages: WebPage[]) => {
  let at = 0
  return {
    fetchPage: vi.fn(),
    readOpen: vi.fn(async () => pages[Math.min(at++, pages.length - 1)]!),
    press: vi.fn(async (): Promise<PageMove> => ({ ok: true, changed: true })),
    typeText: vi.fn(async () => ({ ok: true, changed: true })),
    choose: vi.fn(async () => ({ ok: true, changed: true })),
  } satisfies WebCourier
}
const context = { task: 'Filter the orders' }

it('can inspect controls beyond the first group without performing an extra action', async () => {
  const controls = Array.from({ length: 220 }, (_, at) => `#${at + 1} [button] Item ${at + 1}`)
  const hands = courier([page(controls)])
  const result = JSON.parse(await pageDoTool(hands, picks('more', 'press #220', 'done'), { gate: 'off' })!.run({ goal: 'Open Item 220' }, context))
  expect(result.status).toBe('done')
  expect(hands.press).toHaveBeenCalledExactlyOnceWith('#220', undefined)
})

it('keeps row context separate from the action name used by approval checks', () => {
  const controls = pageControls(page(['#1 [button] Open | row: Submitted expense 42']))
  expect(controls[0]).toMatchObject({ name: 'Open', context: 'Submitted expense 42' })
  expect(pageOptions(controls, undefined)['press #1']).toContain('Submitted expense 42')
})

describe('a short goal on the open page run by a decision model', () => {
  it('retains host commit evidence even when a control label did not reveal it', async () => {
    const hands = courier([page(['#1 [button] Continue'])])
    hands.press.mockResolvedValueOnce({ ok: true, changed: true, committed: true } as PageMove)
    const onCommitted = vi.fn()
    await pageDoTool(hands, picks('press #1', 'done'))!.run({ goal: 'Continue' }, { ...context, onCommitted })
    expect(onCommitted).toHaveBeenCalledOnce()
  })
  it('rejects unoffered or disabled actions without dispatching input', async () => {
    const hands = courier([page(['#1 [button] Next (disabled)', '#2 [input:text] Search'])])
    for (const choice of ['press #1', 'choose #2', 'type #2', 'unknown #2']) {
      expect(JSON.parse(await pageDoTool(hands, picks(choice))!.run({ goal: 'Filter' }, context)).status).toBe('blocked')
    }
    expect(hands.press).not.toHaveBeenCalled()
    expect(hands.choose).not.toHaveBeenCalled()
    expect(hands.typeText).not.toHaveBeenCalled()
  })
  it('offers fields only with text, lists and buttons by their kind, and never a disabled control', () => {
    const controls = pageControls(page(['#1 [button] Filters', '#2 [input:text] Search', '#3 [select] Year', '#4 [button] Next (disabled)', '#5 [input:checkbox] Paid']))
    expect(Object.keys(pageOptions(controls, undefined))).toEqual(['done', 'blocked', 'press #1', 'press #5'])
    expect(Object.keys(pageOptions(controls, '2026'))).toEqual(['done', 'blocked', 'press #1', 'type #2', 'choose #3', 'press #5'])
  })

  it('tells the decision model where on the site the page is, never which site, and traces each step', async () => {
    const hands = courier([page(['#1 [link] Reports'], 'Home', 'http://10.1.2.3:8080/portal?tab=home'), page(['#1 [link] Reports'], 'Reports', 'http://10.1.2.3:8080/reports')])
    const decide = vi.fn().mockResolvedValueOnce({ choice: 'press #1', confidence: 0.8, ms: 300, probabilities: { 'press #1': 0.8, done: 0.15, blocked: 0.05 } }).mockResolvedValueOnce({ choice: 'done', confidence: 0.9, ms: 200 })
    const trace = vi.fn()
    await pageDoTool(hands, decide, { trace })!.run({ goal: 'Open the reports' }, context)
    const state = decide.mock.calls[0]![0] as string
    expect(state).toContain('Page: Orders (/portal?tab=home)')
    expect(state).not.toContain('10.1.2.3')
    expect(trace.mock.calls[0]![0]).toMatchObject({ step: 0, choice: 'press #1', top: [['press #1', 0.8], ['done', 0.15], ['blocked', 0.05]], moved: true, urlAfter: 'http://10.1.2.3:8080/reports', changed: true })
    expect(trace.mock.calls[1]![0]).toMatchObject({ step: 1, choice: 'done' })
  })

  it('presses and types what the model picks until the page shows the goal met', async () => {
    const hands = courier([page(['#1 [button] Filters']), page(['#1 [button] Filters (open)', '#2 [input:text] From']), page(['#2 [input:text] From'], 'Orders from 2026')])
    const decide = picks('press #1', 'type #2', 'done')
    const result = JSON.parse(await pageDoTool(hands, decide)!.run({ goal: 'Show orders from 2026', text: '2026' }, context))
    expect(result).toMatchObject({ status: 'done', steps: ['press #1 "Filters"', 'type #2 "From"'] })
    expect(hands.press).toHaveBeenCalledWith('#1', undefined)
    expect(hands.typeText).toHaveBeenCalledWith('#2', '2026', false, undefined)
  })

  it('stops before anything hard to take back, and when a pick changes nothing', async () => {
    const hands = courier([page(['#1 [button] Delete order'])])
    expect(JSON.parse(await pageDoTool(hands, picks('press #1'))!.run({ goal: 'Clean up' }, context))).toMatchObject({ status: 'needs-person' })
    expect(hands.press).not.toHaveBeenCalled()
    const stuck = courier([page(['#1 [button] More'])])
    expect(JSON.parse(await pageDoTool(stuck, picks('press #1', 'press #1'))!.run({ goal: 'Show more' }, context))).toMatchObject({ status: 'blocked', steps: ['press #1 "More"'] })
  })

  it('goes around a control that would not take the move instead of giving up', async () => {
    const hands = courier([page(['#1 [button] Career', '#2 [button] Filters']), page(['#1 [button] Career', '#2 [button] Filters']), page(['#3 [button] Entry level'], 'Filters open'), page(['#3 [button] Entry level (selected)'])])
    hands.press.mockResolvedValueOnce({ ok: false, error: 'locator.click: Timeout 3000ms exceeded.\nCall log: waiting' })
    const result = JSON.parse(await pageDoTool(hands, picks('press #1', 'press #2', 'press #3', 'done'))!.run({ goal: 'Filter to entry level' }, context))
    expect(result.status).toBe('done')
    expect(result.steps).toEqual(['press #1 "Career" - did not go through: locator.click: Timeout 3000ms exceeded.', 'press #2 "Filters"', 'press #3 "Entry level"'])
  })
})
