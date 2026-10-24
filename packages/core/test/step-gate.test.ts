import { describe, expect, it, vi } from 'vitest'
import type { PageMove, WebCourier, WebPage } from '../src/errand.js'
import { pageDoTool, type PageChoice } from '../src/page-do.js'
import { stepGate } from '../src/step-gate.js'

describe('the gate on each step', () => {
  it('bans what was done from a page once the run is back on it, and what would not go through', () => {
    const gate = stepGate('on')
    gate.arrive('home'); gate.moved('home', 'press #1', true, 'https://x.test/', 0.9)
    gate.arrive('promo'); gate.moved('promo', 'press #1', true, 'https://x.test/promo', 0.9)
    expect(gate.banned('home')).toEqual([])
    gate.arrive('home')
    expect(gate.banned('home')).toEqual(['press #1'])
    gate.moved('settings', 'press #2', false, 'https://x.test/settings', 1)
    expect(gate.banned('settings')).toEqual(['press #2'])
    expect(stepGate('off').banned('home')).toEqual([])
  })

  it('tries the best way left when a stop comes right after a move that would not go through', () => {
    const gate = stepGate('on')
    gate.moved('settings', 'press #2', false, 'https://x.test/settings', 1)
    expect(gate.insist('settings', { choice: 'blocked', confidence: 0.55, probabilities: { blocked: 0.55, 'press #4': 0.23, 'press #2': 0.1 } })).toBe('press #4')
    expect(gate.insist('settings', { choice: 'blocked', confidence: 0.9, probabilities: { blocked: 0.9, 'press #4': 0.05 } })).toBeNull()
    expect(gate.insist('elsewhere', { choice: 'blocked', confidence: 0.55, probabilities: { blocked: 0.55, 'press #4': 0.23 } })).toBeNull()
  })

  it('goes back from a dead end to where the last pick was made, at most twice, and bars that pick there', () => {
    const gate = stepGate('on')
    gate.moved('docs', 'press #3', true, 'https://x.test/docs', 0.6)
    gate.moved('doc', 'press #1', true, 'https://x.test/doc/9', 0.5)
    expect(gate.doubtful()).toBe(true)
    expect(gate.rollback()).toBe('https://x.test/doc/9')
    expect(gate.banned('doc')).toEqual(['press #1'])
    expect(gate.rollback()).toBe('https://x.test/docs')
    expect(gate.banned('docs')).toEqual(['press #3'])
    gate.moved('docs', 'press #2', true, 'https://x.test/docs', 0.6)
    expect(gate.rollback()).toBeNull()
    const sure = stepGate('on')
    sure.moved('list', 'press #3', true, 'https://x.test/', 0.98)
    expect(sure.doubtful()).toBe(false)
    expect(sure.rollback()).toBeNull()
    expect(stepGate('off').rollback()).toBeNull()
  })

  it('does not give up on a page a way already led back to while another way is left', () => {
    const gate = stepGate('on')
    gate.arrive('home'); gate.moved('home', 'press #1', true, 'https://x.test/', 0.99)
    gate.arrive('error'); gate.moved('error', 'press #1', true, 'https://x.test/error', 0.9)
    gate.arrive('home')
    expect(gate.insist('home', { choice: 'blocked', confidence: 0.58, probabilities: { blocked: 0.72, 'press #2': 0.19, done: 0.09 } })).toBe('press #2')
  })

  it('undoes a sure pick only when where it led shows no sign of the goal', () => {
    const goal = stepGate('on')
    goal.moved('list', 'press #3', true, 'https://x.test/', 0.98)
    expect(goal.rollback({ choice: 'blocked', confidence: 0.5, probabilities: { blocked: 0.5, done: 0.3 } })).toBeNull()
    const wall = stepGate('on')
    wall.moved('home', 'press #1', true, 'https://x.test/', 0.99)
    expect(wall.rollback({ choice: 'press #1', confidence: 0.34, probabilities: { 'press #1': 0.56, blocked: 0.44, done: 0 } })).toBe('https://x.test/')
  })

  it('lets a page just reached settle once before a stop there is taken', () => {
    const gate = stepGate('on')
    expect(gate.settleStop('archive', { choice: 'blocked', confidence: 0.79 })).toBe(false)
    gate.moved('files', 'press #2', true, 'https://x.test/files', 1)
    expect(gate.settleStop('archive', { choice: 'blocked', confidence: 0.79 })).toBe(true)
    expect(gate.settleStop('archive', { choice: 'blocked', confidence: 0.79 })).toBe(false)
    expect(gate.settleStop('other', { choice: 'done', confidence: 0.9 })).toBe(false)
  })

  it('looks again only at close picks, likely-met stops and repeats where the page is', () => {
    const gate = stepGate('on')
    expect(gate.contrast({ choice: 'press #3', confidence: 0.59, probabilities: { 'press #3': 0.59, 'press #2': 0.4, blocked: 0.01 } })).toEqual(['press #3', 'press #2'])
    expect(gate.contrast({ choice: 'press #3', confidence: 0.94, probabilities: { 'press #3': 0.94, 'press #2': 0.05 } })).toBeNull()
    expect(gate.doneCheck({ choice: 'blocked', confidence: 0.5, probabilities: { blocked: 0.5, done: 0.28 } }, false)).toBe(true)
    expect(gate.doneCheck({ choice: 'press #1', confidence: 0.9, probabilities: { 'press #1': 0.9, done: 0.1 } }, false)).toBe(false)
    gate.made('/search', 'type #1')
    expect(gate.settle('/search', 'type #1')).toBe(true)
    expect(gate.settle('/search', 'press #2')).toBe(false)
    expect(stepGate('always').contrast({ choice: 'press #3', confidence: 0.94, probabilities: { 'press #3': 0.94, 'press #2': 0.05 } })).toEqual(['press #3', 'press #2'])
  })
})

// A portal whose first link lands on a promotion; the way is through the notices.
function portal(): WebCourier & { log: string[] } {
  const pages: Record<string, WebPage> = {
    home: { url: 'https://x.test/', title: 'Portal', text: 'Portal', controls: ['#1 [link] Security notice', '#2 [link] Notices'] },
    promo: { url: 'https://x.test/promo', title: 'Promotion', text: 'Sign up', controls: ['#1 [link] Home'] },
    notices: { url: 'https://x.test/notices', title: 'Notices', text: 'Notices', controls: ['#1 [link] Leave policy'] },
    notice: { url: 'https://x.test/notice/17', title: 'Leave policy', text: 'Leave policy', controls: [] },
  }
  let at = 'home'
  const log: string[] = []
  const go: Record<string, Record<string, string>> = { home: { '#1': 'promo', '#2': 'notices' }, promo: { '#1': 'home' }, notices: { '#1': 'notice' } }
  return {
    log,
    fetchPage: vi.fn(),
    readOpen: async () => pages[at]!,
    press: async (target): Promise<PageMove> => { log.push(`${at}:${target}`); at = go[at]?.[target] ?? at; return { ok: true, changed: true } },
    typeText: async () => ({ ok: true }),
    choose: async () => ({ ok: true }),
  }
}

it('goes another way from a page it came back to, where an ungated run goes round in a circle', async () => {
  // A decision model that always prefers the first link it is offered.
  const decide = vi.fn(async (_state: string, _instructions: string, criteria: Record<string, string>) => {
    const pick = Object.keys(criteria).find(option => option.startsWith('press')) ?? 'done'
    return { choice: pick, confidence: 0.9, ms: 1, probabilities: { [pick]: 0.9, done: 0.05, blocked: 0.05 } }
  })
  const off = portal()
  expect(JSON.parse(await pageDoTool(off, decide)!.run({ goal: 'Open the leave policy notice', maxSteps: 6 }, { task: 'x' })).url).not.toBe('https://x.test/notice/17')
  expect(off.log.slice(0, 4)).toEqual(['home:#1', 'promo:#1', 'home:#1', 'promo:#1'])
  const on = portal()
  const result = JSON.parse(await pageDoTool(on, decide, { gate: 'on' })!.run({ goal: 'Open the leave policy notice', maxSteps: 6 }, { task: 'x' }))
  expect(on.log).toEqual(['home:#1', 'promo:#1', 'home:#2', 'notices:#1'])
  expect(result.url).toBe('https://x.test/notice/17')
})

it.each(['safe', 'already-committed', 'replay-committed', 'refused'] as const)('replays a tab safely and stops on unsafe replay: %s', async mode => {
  // One address; a tab switches the list in place.
  let view = 'all', where = 'app'
  const log: string[] = []
  const lists: Record<string, string[]> = { all: ['#1 [button] Mine', '#2 [link] Budget - Kim'], mine: ['#1 [button] All', '#2 [link] Budget - draft', '#3 [link] Budget (to approve)'] }
  const pageNow = (): WebPage => where === 'app' ? { url: 'https://x.test/app', title: 'Docs', text: view, controls: lists[view] } : { url: `https://x.test/${where}`, title: where, text: where, controls: [] }
  const hands: WebCourier = {
    fetchPage: async (url) => { log.push(`open ${url}`); where = 'app'; view = 'all'; return pageNow() },
    readOpen: async () => pageNow(),
    press: async (target): Promise<PageMove> => {
      log.push(`press ${target}`)
      const name = target.startsWith('#') ? pageNow().controls![Number(target.slice(1)) - 1]!.replace(/^#\d+ \[\w+\] /, '') : target
      if (name === 'Mine') view = 'mine'
      else if (name === 'All') view = 'all'
      else if (name === 'Budget - draft') where = 'draft'
      else if (name === 'Budget (to approve)') where = 'approve'
      if (name === 'Mine' && mode === 'already-committed') return { ok: true, changed: true, committed: true }
      if (target === 'Mine' && mode === 'replay-committed') return { ok: true, changed: true, committed: true }
      if (target === 'Mine' && mode === 'refused') return { ok: false, refused: 'needs approval' }
      return { ok: true, changed: true }
    },
    typeText: async () => ({ ok: true }),
    choose: async () => ({ ok: true }),
  }
  // Mine (sure), the draft (unsure), a dead end there; back on Mine's list it takes the other budget.
  const decide = vi.fn()
    .mockResolvedValueOnce({ choice: 'press #1', confidence: 0.9, ms: 1, probabilities: { 'press #1': 0.9, 'press #2': 0.1 } })
    .mockResolvedValueOnce({ choice: 'press #2', confidence: 0.55, ms: 1, probabilities: { 'press #2': 0.55, 'press #3': 0.45 } })
    .mockResolvedValueOnce({ choice: 'blocked', confidence: 0.9, ms: 1, probabilities: { blocked: 0.9, done: 0.01 } })
    .mockResolvedValueOnce({ choice: 'press #3', confidence: 0.8, ms: 1, probabilities: { 'press #3': 0.8, 'press #1': 0.2 } })
    .mockResolvedValue({ choice: 'done', confidence: 0.9, ms: 1, probabilities: { done: 0.9 } })
  const onCommitted = vi.fn()
  const running = pageDoTool(hands, decide, { gate: 'on', gateMargin: 0 })!.run({ goal: 'Open the budget I am to approve', maxSteps: 8 }, { task: 'x', onCommitted })
  if (mode !== 'safe') {
    await expect(running).rejects.toThrow(/replay/)
    expect(log).not.toContain('press #3')
    expect(onCommitted).toHaveBeenCalledTimes(mode === 'refused' ? 0 : 1)
    if (mode === 'already-committed') expect(log).not.toContain('press Mine')
    return
  }
  const result = JSON.parse(await running)
  expect(log).toEqual(['press #1', 'press #2', 'open https://x.test/app', 'press Mine', 'press #3'])
  expect(result.url).toBe('https://x.test/approve')
})

it('follows the other way from a close call before taking a goal as met, and keeps the page that fits it', async () => {
  let at = 'docs'
  const pages: Record<string, WebPage> = {
    docs: { url: 'https://x.test/docs', title: 'All documents', text: 'All documents', controls: ['#1 [link] All', '#2 [link] Mine', '#3 [link] Budget - Kim'] },
    mine: { url: 'https://x.test/docs?tab=mine', title: 'Mine', text: 'To approve', controls: ['#1 [link] All', '#2 [link] Mine', '#3 [link] Budget (to approve)'] },
    kim: { url: 'https://x.test/doc/kim', title: 'Budget - Kim', text: 'A budget Kim filed', controls: [] },
    approve: { url: 'https://x.test/approve/77', title: 'Budget - to approve', text: 'A budget waiting for my approval', controls: [] },
  }
  const go: Record<string, Record<string, string>> = { docs: { '#2': 'mine', Mine: 'mine', '#3': 'kim' }, mine: { '#3': 'approve' } }
  const hands: WebCourier = {
    fetchPage: async (url) => { at = Object.keys(pages).find(key => pages[key]!.url === url) ?? 'docs'; return pages[at]! },
    readOpen: async () => pages[at]!,
    press: async (target): Promise<PageMove> => { at = go[at]?.[target] ?? at; return { ok: true, changed: true } },
    typeText: async () => ({ ok: true }),
    choose: async () => ({ ok: true }),
  }
  const decide = vi.fn(async (state: string, _instructions: string, criteria: Record<string, string>): Promise<PageChoice> => {
    if ('first' in criteria) return { choice: 'second', confidence: 0.8, ms: 1 }
    if (state.includes('Page: All documents')) return { choice: 'press #3', confidence: 0.85, ms: 1, probabilities: { 'press #3': 0.62, 'press #2': 0.36, blocked: 0.02 } }
    if (state.includes('Page: Mine')) return { choice: 'press #3', confidence: 0.9, ms: 1, probabilities: { 'press #3': 0.9, blocked: 0.1 } }
    return { choice: 'done', confidence: 0.9, ms: 1, probabilities: { done: 0.9, blocked: 0.1 } }
  })
  const trace = vi.fn()
  const result = JSON.parse(await pageDoTool(hands, decide, { gate: 'on', gateMargin: 0, gateExplore: true, trace })!.run({ goal: 'Open the budget in my approvals', maxSteps: 8 }, { task: 'x' }))
  expect(result.url).toBe('https://x.test/approve/77')
  expect(trace.mock.calls.flatMap(([step]) => step.gate ?? [])).toEqual(expect.arrayContaining(['explore', 'compare:second']))
})
