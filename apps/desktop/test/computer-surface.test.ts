import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBindingDto, DesktopControlStatusDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  session: { available: true, controlSupported: true as boolean | null, error: '', bindings: [] as DesktopBindingDto[], control: { state: 'idle' } as DesktopControlStatusDto },
  grant: false,
}))
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
vi.mock('../src/renderer/src/lib/desktopSession.js', () => ({
  useDesktopSession: () => fake.session, hasDesktopGrant: () => fake.grant,
  desktopError: (error: unknown) => String(error), refreshDesktop: vi.fn(), stopComputerControl: vi.fn(),
}))
vi.mock('../src/renderer/src/components/DesktopVideo.js', () => ({ DesktopVideo: () => null }))
vi.mock('../src/renderer/src/components/DesktopControls.js', () => ({ DesktopControls: () => null }))
import { ComputerSurface } from '../src/renderer/src/components/ComputerSurface.js'

const render = () => renderToStaticMarkup(createElement(ComputerSurface, { lane: 'bot-one' }))
beforeEach(() => {
  fake.grant = false
  fake.session = {
    available: true, controlSupported: true, error: '',
    bindings: [{ lane: 'bot-one', source: 'window:100:0', name: 'Selected fixture', readable: false, stopped: false }],
    control: { state: 'paused', lane: 'bot-one' },
  }
})

describe('computer connection recovery controls', () => {
  it('offers fresh consent after ordinary user takeover', () => {
    const html = render()
    expect(html).toContain('Allow control again')
    expect(html).not.toContain('Reconnect app window')
  })

  it.each(['paused', 'idle'] as const)('offers reconnect and keeps the picker available after terminal closure in %s state', (state) => {
    fake.session.bindings[0]!.stopped = true
    fake.session.control = { state, ...(state === 'paused' ? { lane: 'bot-one' } : {}) }
    const html = render()
    expect(html).toContain('Reconnect app window')
    expect(html).toContain('Reconnect the app window to continue.')
    expect(html).not.toContain('Allow control again')
    expect(html).not.toContain('Allow control for this session')
    const picker = html.match(/<button[^>]*aria-label="Change window: Selected fixture"[^>]*>/)?.[0]
    expect(picker).toBeDefined()
    expect(picker).not.toContain('disabled')
  })

  it('still blocks reconnecting a different window while another chat controls the desktop', () => {
    fake.session.bindings[0]!.stopped = true
    fake.session.control = { state: 'running', lane: 'bot-other' }
    fake.grant = true
    const html = render()
    expect(html.match(/<button[^>]*aria-label="Change window: Selected fixture"[^>]*>/)?.[0]).toContain('disabled')
    expect(html).toContain('Another chat has computer control')
  })

  it.each([false, null])('disables control for an unsupported or unverified connection (%s), preserving manual reading', (supported) => {
    fake.session.control = { state: 'idle' }
    fake.session.controlSupported = supported
    const html = render()
    expect(html.match(/<button[^>]*data-testid="computer-control-start"[^>]*>/)?.[0]).toContain('disabled')
    expect(html.match(/<button[^>]*>Allow reading<\/button>/)?.[0]).not.toContain('disabled')
    expect(html.match(/<button[^>]*aria-label="Change window: Selected fixture"[^>]*>/)?.[0]).not.toContain('disabled')
    if (supported === false) expect(html).toContain('Preview and manual window-text reading remain available')
  })

  it('does not offer an enabled regrant after the selected connection loses support', () => {
    fake.session.controlSupported = false
    expect(render().match(/<button[^>]*>Allow control again<\/button>/)?.[0]).toContain('disabled')
  })

  it('describes manual text permission without promising unsupported AI reading', () => {
    fake.session.control = { state: 'idle' }
    fake.session.controlSupported = false
    fake.session.bindings[0]!.readable = true
    const html = render()
    expect(html).toContain('Window text access is enabled')
    expect(html).not.toContain('AI can read this window')
    expect(html).toContain('aria-label="Read window text"')
  })
})
