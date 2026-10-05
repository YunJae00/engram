import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ phase: '', destroyed: false }))
vi.mock('electron', () => ({ BrowserWindow: class {
  webContents = {
    setWindowOpenHandler() {},
    executeJavaScript: async (script: string) => {
      if (state.phase === 'init' && script.startsWith('(() =>') || state.phase === 'frame' && script.startsWith('window.addFrame') || state.phase === 'finish' && script === 'window.finish()') return new Promise(() => {})
      return Buffer.from('video').toString('base64')
    },
  }
  async loadURL() { if (state.phase === 'load') return new Promise<void>(() => {}) }
  isDestroyed() { return state.destroyed }
  destroy() { state.destroyed = true }
} }))
import { videoEncoder } from '../src/main/evidence-video.js'

beforeEach(() => { vi.useFakeTimers(); state.phase = ''; state.destroyed = false })
afterEach(() => { vi.useRealTimers() })

it.each(['load', 'init', 'frame', 'finish'])('bounds an unresponsive encoder %s and releases its window', async phase => {
  if (phase === 'load' || phase === 'init') {
    state.phase = phase
    const checked = expect(videoEncoder()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await checked
  } else {
    const encoder = await videoEncoder()
    state.phase = phase
    const checked = expect(phase === 'frame' ? encoder.frame(Buffer.from('frame')) : encoder.finish()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await checked
  }
  expect(state.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
