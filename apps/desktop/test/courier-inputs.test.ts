import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: {
    fetch: (to: string, init: RequestInit) => fetch(to, init),
    request: ({ url }: { url: string }) => {
      const emitter = new EventEmitter()
      const outgoing = httpRequest(url, (incoming) => {
        incoming.resume()
        if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) emitter.emit('redirect', incoming.statusCode, 'GET', incoming.headers.location ?? '', incoming.headers)
        else emitter.emit('response', incoming)
      })
      outgoing.on('error', (error) => emitter.emit('error', error))
      return Object.assign(emitter, { end: () => outgoing.end(), abort: () => outgoing.destroy() })
    },
  },
}))
vi.mock('../src/main/agent-browser.js', () => ({
  DEFAULT_LANE: 'default',
  NAV_TIMEOUT_MS: 15000,
  agentAbortable: <T>(work: Promise<T>) => work,
  ensureAgentPage: () => Promise.reject(new Error('Not enough free memory to open a browser tab')),
  armIdleClose: () => undefined,
}))
vi.mock('../src/main/agent-view.js', () => ({ touchedAt: () => 0 }))

const { appCourier } = await import('../src/main/app-courier.js')
const { agentCourier } = await import('../src/main/agent-courier.js')

const ALMANAC = `<html><head><title>Lighthouse keepers' almanac</title></head><body>
<h1>Tide tables for the northern capes</h1>
<p>${'The lamp is trimmed at dusk and the logbook records every passing hull, the swell height and the wind. '.repeat(4)}</p>
<a href="/keepers/rota">Keeper rota</a> <a href="https://charts.example.org/cape">Cape chart</a>
</body></html>`

let server: Server, base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/beacon') { res.writeHead(302, { location: '/almanac' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ALMANAC)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const plainNetwork = {
  fetch: (to: string, init: RequestInit) => fetch(to, init),
  follow: async (url: string) => {
    const answer = await fetch(url, { redirect: 'manual' })
    const target = answer.headers.get('location')
    return answer.status >= 300 && answer.status < 400 && target ? new URL(target, url).href : null
  },
}

it('reads a page and follows a redirect the same through a plain network as through the app courier', async () => {
  const plain = agentCourier({ network: plainNetwork, touchedAt: () => 0, lane: 'bot-lighthouse' })
  const app = appCourier({ lane: 'bot-lighthouse' })
  const viaPlain = await plain.fetchPage(`${base}/almanac`)
  const viaApp = await app.fetchPage(`${base}/almanac`)
  expect({ title: viaPlain.title, text: viaPlain.text, links: viaPlain.links }).toEqual({ title: viaApp.title, text: viaApp.text, links: viaApp.links })
  expect(viaPlain.text).toContain('Tide tables for the northern capes')
  expect(viaPlain.links).toEqual([{ text: 'Keeper rota', url: `${base}/keepers/rota` }, { text: 'Cape chart', url: 'https://charts.example.org/cape' }])
  for (const courier of [plain, app]) {
    expect(await courier.followRedirect!(`${base}/beacon`)).toBe(`${base}/almanac`)
    expect(await courier.followRedirect!(`${base}/almanac`)).toBeNull()
  }
})
