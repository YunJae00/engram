import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/desktopSession.js', () => ({
  useDesktopSession: () => ({ bindings: [], control: null }), desktopError: (error: unknown) => String(error), stopComputerControl: vi.fn(),
}))
import { BotComputerView, browserTabRows, laneBinding } from '../src/renderer/src/components/BotComputerTab.js'

const lane = 'bot-b1'
const empty = createElement('div', { 'data-testid': 'bot-info-empty' }, createElement('p', null, 'Soon'), createElement('button', { type: 'button' }, 'Close'))

describe('bot info computer tab', () => {
  it('keeps only well-formed browser tabs from IPC', () => {
    expect(browserTabRows([
      { id: 't1', url: 'https://a.example/', title: 'A', active: true },
      { id: 't2', url: 'about:blank', title: 7, active: 'yes' },
      { id: '', url: 'https://b.example/' },
      { id: 't3', url: 5 },
      null, 'tab', 3,
    ])).toEqual([
      { id: 't1', url: 'https://a.example/', title: 'A', active: true },
      { id: 't2', url: 'about:blank', active: false },
    ])
    for (const bad of [undefined, null, 'tabs', { length: 1, 0: { id: 't1', url: 'x' } }, 4]) expect(browserTabRows(bad)).toEqual([])
    const bindings = [{ lane: 'bot-x', name: 'Other' }, { lane, name: 3 }, { lane, source: 's1', name: 'Notes' }, { lane, name: 'Later' }]
    expect(laneBinding(bindings, lane)?.name).toBe('Notes')
    expect(laneBinding(bindings, 'bot-none')).toBeUndefined()
    expect(laneBinding({ length: 1, 0: { lane, name: 'Notes' } }, lane)).toBeUndefined()
    expect(laneBinding(null, lane)).toBeUndefined()
  })

  it('shows the empty block when the bot has no tabs, window or control', () => {
    expect(renderToStaticMarkup(createElement(BotComputerView, { tabs: [], empty }))).toBe(renderToStaticMarkup(empty))
  })

  it('lists the tabs and the desktop control state of this bot', () => {
    const html = renderToStaticMarkup(createElement(BotComputerView, {
      tabs: [
        { id: 't1', url: 'https://a.example/x', title: 'Docs', active: true },
        { id: 't2', url: 'https://news.example.org/story', active: false },
        { id: 't3', url: 'about:blank', active: false },
      ],
      binding: { lane, source: 's1', name: 'Notes window', readable: true },
      control: { state: 'running', lane, engineLabel: 'Claude' },
      empty,
    }))
    const items = [...html.matchAll(/<li data-testid="bot-computer-tab"[^>]*>([^<]*)<\/li>/g)].map(match => match[1])
    expect(items).toEqual(['Docs', 'news.example.org', 'New tab'])
    expect(html).toContain('<p data-testid="bot-computer-window">Notes window</p>')
    expect(html).toContain('<p data-testid="bot-computer-control">Claude is controlling your computer</p>')
    expect(html).not.toContain('bot-info-empty')
  })
})
