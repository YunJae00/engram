import { expect, it, vi } from 'vitest'
import type { Engine } from 'core'

const forget = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const selection = vi.hoisted(() => ({ profile: 'system' }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/engine-cloud.js', () => ({ cloudEngine: () => ({ forgetStatus: forget, confirmAuth: confirm }) }))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [] }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => selection.profile }))
import { engineDto, engineHealthOf, markEngineOk, noteEngineFailure } from '../src/main/engine-health.js'

it('revokes cached auth after a real call fails without changing another account', async () => {
  await noteEngineFailure({ id: 'codex', accountProfile: 'work' } as unknown as Engine, 'auth')
  expect(forget).not.toHaveBeenCalled()
  await noteEngineFailure({ id: 'codex', accountProfile: 'system' } as unknown as Engine, 'auth')
  expect(forget).toHaveBeenCalledOnce()
  expect(engineHealthOf('codex')).toEqual({ healthy: false, reason: 'auth' })
  expect(engineDto({ id: 'codex', authConfirmed: true } as unknown as Engine)).toMatchObject({ loggedIn: true, healthy: false, healthReason: 'auth' })
  markEngineOk('codex', 'work')
  expect(engineHealthOf('codex')).toEqual({ healthy: false, reason: 'auth' })
  expect(engineHealthOf('codex', 'work')).toEqual({ healthy: true })
  selection.profile = 'work'
  expect(engineHealthOf('codex')).toEqual({ healthy: true })
  selection.profile = 'system'
  expect(engineHealthOf('codex')).toEqual({ healthy: false, reason: 'auth' })
  markEngineOk('codex', 'system')
  expect(engineHealthOf('codex')).toEqual({ healthy: true })
  expect(confirm).toHaveBeenCalledWith()
  expect(engineDto({ id: 'codex', authConfirmed: false } as unknown as Engine).conclusive).toBeUndefined()
})
