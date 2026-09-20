import { test, expect, _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DevelopersApi } from '../src/shared/developers.js'
import type { EngramApi } from '../src/shared/types.js'

test.skip(process.env['ENGRAM_DEV_LIVE'] !== '1', 'Requires explicit live provider verification.')
test('connected account limits load before any development session exists', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'account-live-')), userData = join(root, 'data'), vault = join(root, 'vault')
  await Promise.all([mkdir(userData), initVault(vault, { git: false })])
  const source = process.env['ENGRAM_DEV_CLAUDE_RUNTIME']
  if (!source) throw new Error('Set ENGRAM_DEV_CLAUDE_RUNTIME to the existing runtimes directory.')
  await symlink(source, join(userData, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir')
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    for (const provider of ['claude', 'codex'] as const) {
      const usage = await page.evaluate(provider => (window as unknown as { engram: DevelopersApi }).engram.devUsage(provider), provider)
      expect(usage.unavailable, `${provider} usage`).toBeUndefined()
      expect(usage.windows?.length).toBeGreaterThan(0)
    }
    const state = await page.evaluate(() => (window as unknown as { engram: DevelopersApi }).engram.devState())
    expect(state.sessions).toHaveLength(0)
    expect(state.preferences.enabled).toBe(false)
    for (const provider of ['claude', 'codex'] as const) {
      const result = await page.evaluate(async provider => {
        const api = (window as unknown as { engram: EngramApi }).engram
        const profiles = await api.accountProfileAdd(provider, 'Isolation check')
        const profile = profiles.profiles.find(row => row.provider === provider)!.id
        await api.accountProfileUse(provider, profile)
        const states = await api.accountProfileStates()
        const usage = await api.devUsage(provider, 'system')
        await api.accountProfileUse(provider, 'system')
        return { isolated: states.find(row => row.provider === provider && row.id === profile), usage }
      }, provider)
      expect(result.isolated?.loggedIn).toBe(false)
      expect(result.isolated?.conclusive).not.toBe(false)
      expect(result.usage.unavailable).toBeUndefined()
      expect(result.usage.windows?.length).toBeGreaterThan(0)
    }
  } finally { await app.close() }
})
