import { beforeEach, describe, expect, it, vi } from 'vitest'

// Detection spawns two subprocesses and EIGHT paths ask for it independently
// (boot, auto-install's presence check, the auth watch, window focus, the
// Diagnostics 4s poll, power resume, install-ready, and every failed chat
// call). Boot fires two within milliseconds of each other. This pins the rule
// that overlapping callers share one probe — on the slow machines that report
// Claude disconnecting, answering a slow probe by launching three more is the
// worst thing the app can do.
//
// spawn.js is mocked so the suite never touches a real CLI: it counts calls and
// hands back the settle functions, so a probe finishes exactly when the test
// says so.
const probeCalls = vi.fn()
const waiting: { resolve: (v: boolean | null) => void; reject: (e: Error) => void }[] = []

vi.mock('../src/engine/spawn.js', () => ({
  probeCli: (binary: string) => {
    probeCalls(binary)
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject })
    })
  },
  spawnLines: vi.fn(),
  errorEvent: vi.fn(),
}))

const { ClaudeAdapter } = await import('../src/engine/claude.js')

const adapter = () => new ClaudeAdapter(1000, 'claude')

beforeEach(() => {
  probeCalls.mockClear()
  waiting.length = 0
})

describe('ClaudeAdapter.detect collapses concurrent probes', () => {
  it('four overlapping callers spawn one probe and all get the same answer', async () => {
    // Four separate adapters, because createEngine builds a new one per caller —
    // per-instance state would coordinate nothing.
    const pending = [0, 1, 2, 3].map(() => adapter().detect())
    await Promise.resolve()
    expect(probeCalls).toHaveBeenCalledTimes(1)

    waiting[0]!.resolve(false)
    const results = await Promise.all(pending)
    expect(probeCalls).toHaveBeenCalledTimes(1)
    for (const r of results) expect(r).toEqual({ installed: false, loggedIn: false, conclusive: true })
  })

  it('a finished NEGATIVE is never reused — the next caller asks again', async () => {
    const first = adapter().detect()
    waiting[0]!.resolve(false)
    await first
    expect(probeCalls).toHaveBeenCalledTimes(1)

    const second = adapter().detect()
    waiting[1]!.resolve(false)
    await second
    expect(probeCalls).toHaveBeenCalledTimes(2)
  })

  it('different binaries are different questions', async () => {
    // The managed copy and the one on PATH can genuinely disagree; collapsing
    // them would report one machine's answer for the other's binary.
    const managed = new ClaudeAdapter(1000, '/managed/claude').detect()
    const onPath = adapter().detect()
    await Promise.resolve()
    expect(probeCalls).toHaveBeenCalledTimes(2)
    expect(probeCalls).toHaveBeenNthCalledWith(1, '/managed/claude')
    expect(probeCalls).toHaveBeenNthCalledWith(2, 'claude')

    waiting[0]!.resolve(false)
    waiting[1]!.resolve(false)
    await Promise.all([managed, onPath])
  })

  it('a probe that throws does not wedge detection for the life of the process', async () => {
    // .finally must clear the map entry on the rejection path too. Without it
    // one spawn failure leaves a rejected promise cached forever and every
    // later detection replays the same error — the engine would never come
    // back without a restart.
    const failing = adapter().detect()
    waiting[0]!.reject(new Error('spawn EACCES'))
    await expect(failing).rejects.toThrow('EACCES')

    const after = adapter().detect()
    expect(probeCalls).toHaveBeenCalledTimes(2)
    waiting[1]!.resolve(false)
    await expect(after).resolves.toEqual({ installed: false, loggedIn: false, conclusive: true })
  })
})
