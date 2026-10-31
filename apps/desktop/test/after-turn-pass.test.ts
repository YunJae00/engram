import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { registerStudyIpc } from '../src/main/study-ipc.js'

it('offers explicit study actions without an automatic after-turn judge or pass', () => {
  const sendQuiet = vi.fn()
  const study = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: vi.fn() })
  expect(Object.keys(study).sort()).toEqual(['offerStudy', 'setOffersAside', 'studyFound'])
  expect(sendQuiet).not.toHaveBeenCalled()
})
