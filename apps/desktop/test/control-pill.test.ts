import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  api: {
    desktopOverlayStatus: vi.fn<() => Promise<DesktopControlStatusDto>>(),
    desktopControlStop: vi.fn(() => Promise.resolve()),
    desktopControlResume: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn(() => () => {}),
  },
}))
vi.mock('../src/renderer/src/api.js', () => ({ api: fake.api }))
import { ControlPill, primeControlStatus, watchControlStatus } from '../src/renderer/src/views/ControlPill.js'

async function render(status: DesktopControlStatusDto): Promise<string> {
  fake.api.desktopOverlayStatus.mockResolvedValue(status)
  await primeControlStatus()
  return renderToStaticMarkup(createElement(ControlPill))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('control pill copy', () => {
  it('names Comets and the way out while it is running, with Stop only', async () => {
    const html = await render({ state: 'running', engine: 'claude', engineLabel: 'Claude' })
    expect(html).toContain('data-testid="control-pill"')
    expect(html).toContain('data-state="running"')
    expect(html).toContain('data-engine="claude"')
    expect(html).toContain('<strong>Comets using your computer</strong>')
    expect(html).toContain('<span>Esc to take over</span>')
    expect(html).toContain('data-testid="overlay-stop"')
    expect(html).not.toContain('data-testid="overlay-resume"')
  })

  it('offers Resume now beside Stop after a hands-on pause', async () => {
    const html = await render({ state: 'paused', resumable: true, engine: 'codex', engineLabel: 'ChatGPT' })
    expect(html).toContain('data-state="paused"')
    expect(html).toContain('<strong>You took over</strong>')
    expect(html).toContain('<span>Comets will wait for your hands to be still</span>')
    expect(html).toContain('data-testid="overlay-resume"')
    expect(html).toContain('Resume now')
    expect(html).toContain('data-testid="overlay-stop"')
  })

  it.each<DesktopControlStatusDto>([
    { state: 'idle' },
    { state: 'ready' },
    { state: 'needs-person' },
    { state: 'paused', resumable: false },
    { state: 'paused' },
  ])('renders nothing for %o', async (status) => {
    expect(await render(status)).toBe('')
  })

  it('uses the same product wording without an engine label', async () => {
    expect(await render({ state: 'running' })).toContain('<strong>Comets using your computer</strong>')
  })

  it('keeps a status event that landed during the initial query', async () => {
    expect(await render({ state: 'idle' })).toBe('')
    let resolve: (status: DesktopControlStatusDto) => void = () => {}
    fake.api.desktopOverlayStatus.mockReturnValue(new Promise((done) => { resolve = done }))
    const priming = primeControlStatus()
    let deliver: (event: unknown) => void = () => {}
    fake.api.onEvent.mockImplementation((listener) => {
      deliver = listener as (event: unknown) => void
      return () => {}
    })
    const changed = vi.fn()
    const stop = watchControlStatus(changed)
    deliver({ type: 'desktop:control', control: { state: 'running', engineLabel: 'Claude' } })
    expect(changed).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(createElement(ControlPill))).toContain('Comets using your computer')
    // The older answer arrives after the event and must not roll it back.
    resolve({ state: 'idle' })
    await priming
    expect(renderToStaticMarkup(createElement(ControlPill))).toContain('Comets using your computer')
    stop()
    fake.api.onEvent.mockImplementation(() => () => {})
  })
})
