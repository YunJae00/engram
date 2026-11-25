import { net } from 'electron'
import type { WebCourier } from 'core'
import { agentCourier, type CourierDeps, type WebNetwork } from './agent-courier.js'
import { touchedAt } from './agent-view.js'

const shellNetwork: WebNetwork = {
  fetch: (to, init) => net.fetch(to, init),
  follow(url, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(null); return }
      const request = net.request({ url, redirect: 'manual' })
      const done = (target: string | null) => { signal?.removeEventListener('abort', stop); resolve(target); request.abort() }
      const stop = () => done(null)
      signal?.addEventListener('abort', stop, { once: true })
      request.on('redirect', (_status, _method, target) => { try { done(new URL(target, url).href) } catch { done(null) } })
      request.on('response', () => done(null))
      request.on('error', () => done(null))
      request.end()
    })
  },
}

export const appCourier = (deps: Omit<CourierDeps, 'network' | 'touchedAt'> = {}): WebCourier => agentCourier({ ...deps, network: shellNetwork, touchedAt })
