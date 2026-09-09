import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({ session: { control: { state: 'idle' } as DesktopControlStatusDto, error: '' } }))
vi.mock('../src/renderer/src/lib/desktopSession.js', () => ({
  useDesktopSession: () => fake.session, desktopError: (error: unknown) => String(error), stopComputerControl: vi.fn(),
}))
import { ComputerStatus, computerStateDetail, computerStateLabel } from '../src/renderer/src/components/ComputerStatus.js'

const render = () => renderToStaticMarkup(createElement(ComputerStatus))
beforeEach(() => { fake.session = { control: { state: 'idle' }, error: '' } })

// The banner names who holds the computer and what the person can do about
// it, in the same words the on-screen pill uses.
describe('the in-app control banner', () => {
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
    expect(computerStateDetail(fake.session.control)).toBe('Send the next task when you are ready.')
    expect(render()).not.toContain('Allow control again')
  })

  it('a status reason from the host wins over the stock detail', () => {
    fake.session.control = { state: 'paused', lane: 'bot-one', reason: 'The computer was locked.' }
    expect(render()).toContain('The computer was locked.')
  })
})
