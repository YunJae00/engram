import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({ session: { control: { state: 'idle' } as DesktopControlStatusDto, error: '' } }))
vi.mock('../src/renderer/src/lib/desktopSession.js', () => ({
  useDesktopSession: () => fake.session, desktopError: (error: unknown) => String(error), stopComputerControl: vi.fn(),
}))
import { ComputerStatus, computerStateLabel } from '../src/renderer/src/components/ComputerStatus.js'

const render = () => renderToStaticMarkup(createElement(ComputerStatus))
beforeEach(() => { fake.session = { control: { state: 'idle' }, error: '' } })

describe('desktop control stays outside the app', () => {
  it('renders nothing while the computer is the person\'s', () => {
    expect(render()).toBe('')
  })

  it('names the brain at work and the way out', () => {
    fake.session.control = { state: 'running', lane: 'bot-one', name: 'Excel', engine: 'claude', engineLabel: 'Claude' }
    expect(render()).toBe('')
    expect(computerStateLabel(fake.session.control)).toBe('Claude is controlling your computer')
  })

  it('a hands-on pause says the comet will carry on by itself', () => {
    fake.session.control = { state: 'paused', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude', resumable: true }
    expect(render()).toBe('')
  })

  it('Esc or Stop reads as off, with the next task as the way back', () => {
    fake.session.control = { state: 'paused', lane: 'bot-one', engine: 'codex', engineLabel: 'ChatGPT', resumable: false }
    expect(computerStateLabel(fake.session.control)).toBe('Computer control is off')
    expect(render()).toBe('')
  })

  it.each(['ready', 'paused', 'needs-person'] as const)('does not render a banner for %s, including host errors', (state) => {
    fake.session.control = { state, lane: 'bot-one', reason: 'The computer was locked.' }
    fake.session.error = 'The host could not be reached.'
    expect(render()).toBe('')
  })
})
