import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  windows: [1, 2, 3, 4].map((id) => ({ webContents: { id, send: vi.fn() } })),
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => fake.windows } }))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [3, 4] }))

import { broadcast } from '../src/main/engine-health.js'

it('sends app events to app windows without copying frames into control overlays', () => {
  const event = { type: 'mission:frame' as const, frame: { lane: 'bot-test', on: true, data: 'frame' } }
  broadcast(event)
  for (const win of fake.windows.slice(0, 2)) expect(win.webContents.send).toHaveBeenCalledWith('engram:event', event)
  for (const win of fake.windows.slice(2)) expect(win.webContents.send).not.toHaveBeenCalled()
})
