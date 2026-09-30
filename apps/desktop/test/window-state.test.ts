import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
const area = vi.hoisted(() => ({ x: 0, y: 0, width: 1920, height: 1080 }))
vi.mock('electron', () => ({ app: {}, screen: {
  getPrimaryDisplay: () => ({ workArea: area }),
  getAllDisplays: () => [{ workArea: area }],
} }))
import { placeWindow } from '../src/main/window-state.js'

it('starts compact and centred, but preserves an explicitly saved size and maximization', () => {
  const win = { setBounds: vi.fn(), getMinimumSize: () => [800, 560], maximize: vi.fn() }
  placeWindow(win as unknown as BrowserWindow, {})
  expect(win.setBounds).toHaveBeenLastCalledWith({ x: 460, y: 165, width: 1000, height: 750 })
  expect(win.maximize).not.toHaveBeenCalled()
  const bounds = { x: 100, y: 80, width: 1200, height: 800 }
  placeWindow(win as unknown as BrowserWindow, { bounds, maximized: true })
  expect(win.setBounds).toHaveBeenLastCalledWith(bounds)
  expect(win.maximize).toHaveBeenCalledOnce()
})

it('fits a small work area without breaking the initial 4:3 ratio', () => {
  Object.assign(area, { x: -900, y: 40, width: 900, height: 600 })
  const win = { setBounds: vi.fn(), getMinimumSize: () => [800, 560], setMinimumSize: vi.fn(), maximize: vi.fn() }
  try {
    placeWindow(win as unknown as BrowserWindow, {})
    expect(win.setBounds).toHaveBeenCalledWith({ x: -810, y: 70, width: 720, height: 540 })
    expect(win.setMinimumSize).toHaveBeenCalledWith(720, 540)
  } finally {
    Object.assign(area, { x: 0, y: 0, width: 1920, height: 1080 })
  }
})
