import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsDto } from '../src/shared/types.js'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, settings: AppSettingsDto) => Promise<void>>(),
  load: vi.fn(), save: vi.fn(), stop: vi.fn(), broadcast: vi.fn(), changed: vi.fn(),
}))
vi.mock('core', () => ({ createEngine: vi.fn(), ENGINE_ORDER: [] }))
vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: {}, shell: {}, ipcMain: { handle: (name: string, handler: (event: unknown, settings: AppSettingsDto) => Promise<void>) => fake.handlers.set(name, handler) } }))
vi.mock('../src/main/ipc.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/installer.js', () => ({ detectApiKeyEnv: vi.fn() }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fake.load, saveSettings: fake.save }))
vi.mock('../src/main/team.js', () => ({ getSyncStatus: vi.fn() }))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ stopDesktopControl: fake.stop }))
import { registerSettingsIpc, setBrainChoiceHook } from '../src/main/config-ipc.js'

const settings = { defaultEngine: 'claude', autoStart: false, teamSync: 'manual', searchTemplate: '', agentBrowser: '', claudeModel: '', codexModel: '' } as AppSettingsDto
beforeEach(() => {
  vi.clearAllMocks()
  fake.handlers.clear()
  fake.load.mockResolvedValue(settings)
  fake.save.mockResolvedValue(undefined)
  setBrainChoiceHook(fake.changed)
  registerSettingsIpc()
})

describe('desktop grant lifetime when choosing an AI connection', () => {
  it('stops desktop control before refreshing the newly chosen connection', async () => {
    await fake.handlers.get('settings:set')!(null, { ...settings, defaultEngine: 'codex' })
    expect(fake.stop).toHaveBeenCalledExactlyOnceWith('The AI connection changed. Allow computer control again for the selected connection.')
    expect(fake.changed).toHaveBeenCalledOnce()
    expect(fake.stop.mock.invocationCallOrder[0]!).toBeLessThan(fake.changed.mock.invocationCallOrder[0]!)
  })

  it('does not interrupt a grant for an unrelated settings save', async () => {
    await fake.handlers.get('settings:set')!(null, { ...settings, autoStart: true })
    expect(fake.stop).not.toHaveBeenCalled()
    expect(fake.changed).not.toHaveBeenCalled()
  })
})
