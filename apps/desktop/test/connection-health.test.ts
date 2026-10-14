import { expect, it, vi } from 'vitest'
import type { Engine } from 'core'

const forget = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/engine-cloud.js', () => ({ cloudEngine: () => ({ forgetStatus: forget }) }))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [] }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => 'system' }))
import { engineHealthOf, noteEngineFailure, refreshHealthFromDetection } from '../src/main/engine-health.js'
import type { VaultContext } from '../src/main/vault.js'

it('revokes cached auth after a real call fails without changing another account', async () => {
  await noteEngineFailure({ id: 'codex', accountProfile: 'work' } as unknown as Engine, 'auth')
  expect(forget).not.toHaveBeenCalled()
  await noteEngineFailure({ id: 'codex', accountProfile: 'system' } as unknown as Engine, 'auth')
  expect(forget).toHaveBeenCalledOnce()
  expect(engineHealthOf('codex')).toEqual({ healthy: false, reason: 'auth' })
  refreshHealthFromDetection({ engines: [{ id: 'codex', authConfirmed: false }] } as unknown as VaultContext)
  expect(engineHealthOf('codex')).toEqual({ healthy: false, reason: 'auth' })
  refreshHealthFromDetection({ engines: [{ id: 'codex', authConfirmed: true }] } as unknown as VaultContext)
  expect(engineHealthOf('codex')).toEqual({ healthy: true })
})
