import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
vi.mock('electron', () => ({ app: {}, screen: {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
} }))
import { placeWindow } from '../src/main/window-state.js'

it('starts compact and centred, but preserves an explicitly saved size and maximization', () => {
  const win = { setBounds: vi.fn(), getMinimumSize: () => [800, 560], maximize: vi.fn() }
  placeWindow(win as unknown as BrowserWindow, {})
  expect(win.setBounds).toHaveBeenLastCalledWith({ x: 440, y: 160, width: 1040, height: 760 })
  expect(win.maximize).not.toHaveBeenCalled()
  const bounds = { x: 100, y: 80, width: 1200, height: 800 }
  placeWindow(win as unknown as BrowserWindow, { bounds, maximized: true })
  expect(win.setBounds).toHaveBeenLastCalledWith(bounds)
  expect(win.maximize).toHaveBeenCalledOnce()
})
