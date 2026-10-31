vi.mock('../src/main/work-preview.js', () => ({ showBrowserWorkPreview: vi.fn() }))
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ answer: null as unknown as (request: EventEmitter) => void, aborted: 0 }))
vi.mock('electron', () => ({
  net: {
    request: () => {
      const request = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => fake.answer(request)),
        abort: () => { fake.aborted++ },
      })
      return request
    },
  },
}))
vi.mock('../src/main/agent-browser.js', () => ({ DEFAULT_LANE: 'default', NAV_TIMEOUT_MS: 15000, agentAbortable: <T>(work: Promise<T>) => work }))
vi.mock('../src/main/agent-view.js', () => ({ touchedAt: () => 0 }))

const { agentCourier } = await import('../src/main/agent-courier.js')

it('reads where a redirector leads from its first hop, and gives nothing for an answer, a failure or a stop', async () => {
  const courier = agentCourier()
  fake.answer = (request) => request.emit('redirect', 302, 'GET', '/landing?id=1', {})
  expect(await courier.followRedirect!('https://www.engine.test/goto?url=CAES1')).toBe('https://www.engine.test/landing?id=1')
  fake.answer = (request) => request.emit('redirect', 302, 'GET', 'https://www.catch.co.kr/Recruit/1', {})
  expect(await courier.followRedirect!('https://www.engine.test/goto?url=CAES2')).toBe('https://www.catch.co.kr/Recruit/1')
  fake.answer = (request) => request.emit('response', { statusCode: 200 })
  expect(await courier.followRedirect!('https://www.engine.test/goto?url=CAES3')).toBeNull()
  fake.answer = (request) => request.emit('error', new Error('net::ERR_FAILED'))
  expect(await courier.followRedirect!('https://www.engine.test/goto?url=CAES4')).toBeNull()

  fake.answer = () => {}
  const stop = new AbortController()
  const pending = courier.followRedirect!('https://www.engine.test/goto?url=CAES5', stop.signal)
  stop.abort()
  expect(await pending).toBeNull()
  expect(fake.aborted).toBeGreaterThanOrEqual(5)
})
