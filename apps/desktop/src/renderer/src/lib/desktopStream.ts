import { api } from '../api.js'

// A display grant is consumed before another preview requests its own source.
let pending: Promise<unknown> = Promise.resolve()
export function openDesktopStream(lane: string, signal?: AbortSignal): Promise<MediaStream> {
  const start = pending.then(() => startCapture(lane, signal))
  pending = start.catch(() => undefined)
  return start
}

function startCapture(lane: string, signal?: AbortSignal): Promise<MediaStream> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let active = true
    let token: string | undefined
    const cancelGrant = () => { if (token) void api.desktopCancelCapture(token).catch(() => undefined) }
    const finish = () => {
      active = false
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      cancelGrant()
    }
    const fail = (cause: unknown) => { if (active) { finish(); reject(cause) } }
    const abort = () => fail(signal?.reason ?? new DOMException('Live view cancelled.', 'AbortError'))
    const timer = setTimeout(() => fail(new Error('Live view took too long to start. Retry the window.')), 12000)
    signal?.addEventListener('abort', abort, { once: true })
    void (async () => {
      token = await api.desktopPrepareCapture(lane)
      if (!active) { cancelGrant(); return }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { width: { ideal: 2560 }, height: { ideal: 1600 }, frameRate: { ideal: 24, max: 30 } },
      })
      if (!active) { stream.getTracks().forEach((track) => track.stop()); return }
      finish()
      resolve(stream)
    })().catch(fail)
  })
}
