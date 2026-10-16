import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ connection: null as { baseUrl: string; model: string; key: string } | null }))
vi.mock('../src/main/brain-connections.js', () => ({ loadBrainConnections: async () => ({}), brainConnection: () => fake.connection, connectionFetch: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { decideChoice, decisionAvailable } from '../src/main/decision-provider.js'

const criteria = { done: 'All done', blocked: 'Stuck', 'press c1': 'Press New chat' }

describe('the decision model', () => {
  it('is offered only when an endpoint is connected, and needs a model name', async () => {
    fake.connection = null
    expect(await decisionAvailable()).toBe(false)
    await expect(decideChoice('state', 'pick', criteria)).rejects.toThrow(/No decision model/)
    fake.connection = { baseUrl: 'https://gateway.example/v1/gateway/decisions/', model: '', key: 'k' }
    await expect(decideChoice('state', 'pick', criteria)).rejects.toThrow(/model ID/)
  })

  it('asks one choice question and reads the typed answer back', async () => {
    fake.connection = { baseUrl: 'https://gateway.example/v1/gateway/decisions/', model: 'jev-latest', key: 'k' }
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { next: { type: 'choice', choice: 'press c1', confidence: 0.93, probabilities: { 'press c1': 0.93, done: 0.05, blocked: 0.02 } } }, usage: { input_tokens: 400 } }), { status: 200 })
    }) as unknown as typeof fetch
    const decision = await decideChoice('Goal: open a chat', 'pick the next action', criteria, fetchImpl)
    expect(decision).toMatchObject({ choice: 'press c1', confidence: 0.93, probabilities: { done: 0.05 } })
    expect(calls[0]!.url).toBe('https://gateway.example/v1/gateway/decisions/')
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer k', 'content-type': 'application/json' })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ state: 'Goal: open a chat', model: 'jev-latest', questions: { next: { type: 'choice', instructions: 'pick the next action', criteria } } })
  })

  it('names what went wrong: a refused key, a rate limit, an answer outside the options', async () => {
    fake.connection = { baseUrl: 'https://gateway.example/decisions', model: 'jev-latest', key: 'k' }
    const status = (code: number, body = '') => (async () => new Response(body, { status: code })) as unknown as typeof fetch
    await expect(decideChoice('s', 'i', criteria, status(401))).rejects.toThrow(/did not accept the key/)
    await expect(decideChoice('s', 'i', criteria, status(429))).rejects.toThrow(/rate limited/)
    await expect(decideChoice('s', 'i', criteria, status(200, 'not json'))).rejects.toThrow(/JSON/)
    await expect(decideChoice('s', 'i', criteria, status(200, JSON.stringify({ answers: { next: { type: 'choice', choice: 'press c9' } } })))).rejects.toThrow(/not offered/)
    await expect(decideChoice('s', 'i', { only: 'one' }, status(200))).rejects.toThrow(/at least two/)
  })
  it('propagates cancellation to the request without following redirects', async () => {
    const abort = new AbortController()
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      abort.abort()
      init?.signal?.throwIfAborted()
      return new Response('')
    })
    await expect(decideChoice('s', 'i', criteria, fetchImpl as typeof fetch, abort.signal)).rejects.toThrow()
  })
})
