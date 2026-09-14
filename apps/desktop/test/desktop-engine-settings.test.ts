import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsDto } from '../src/shared/types.js'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, settings: AppSettingsDto) => Promise<void>>(),
  load: vi.fn(), save: vi.fn(), stop: vi.fn(), broadcast: vi.fn(), changed: vi.fn(), nativeTheme: { themeSource: 'system' },
}))
vi.mock('core', () => ({ createEngine: vi.fn(), ENGINE_ORDER: [], REASONING_EFFORTS: ['low', 'medium', 'high'] }))
vi.mock('electron', () => ({ app: { isPackaged: false }, nativeTheme: fake.nativeTheme, dialog: {}, shell: {}, ipcMain: { handle: (name: string, handler: (event: unknown, settings: AppSettingsDto) => Promise<void>) => fake.handlers.set(name, handler) } }))
vi.mock('../src/main/ipc.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/installer.js', () => ({ detectApiKeyEnv: vi.fn() }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fake.load, updateSettings: async (change: (settings: AppSettingsDto) => AppSettingsDto) => { const next = change(await fake.load()); await fake.save(next); return next } }))
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
  it('rejects invalid reasoning effort before saving any settings', async () => {
    await expect(fake.handlers.get('settings:set')!(null, { ...settings, claudeEffort: 'invalid' } as unknown as AppSettingsDto)).rejects.toThrow('Invalid reasoning effort')
    expect(fake.save).not.toHaveBeenCalled()
    await fake.handlers.get('settings:set')!(null, { ...settings, claudeEffort: 'high', codexEffort: 'low' })
    expect(fake.save).toHaveBeenLastCalledWith(expect.objectContaining({ claudeEffort: 'high', codexEffort: 'low' }))
  })
  it('saves appearance before applying it and rejects invalid themes', async () => {
    await fake.handlers.get('settings:set')!(null, { ...settings, theme: 'dark' })
    expect(fake.save).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
    expect(fake.nativeTheme.themeSource).toBe('dark')
    await expect(fake.handlers.get('settings:set')!(null, { ...settings, theme: 'blue' } as unknown as AppSettingsDto)).rejects.toThrow('Invalid appearance')
    fake.save.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(fake.handlers.get('settings:set')!(null, { ...settings, theme: 'light' })).rejects.toThrow('disk unavailable')
    expect(fake.nativeTheme.themeSource).toBe('dark')
  })
  it('turning computer use off stops input before settings are persisted', async () => {
    fake.load.mockResolvedValue({ ...settings, computerUse: true })
    await fake.handlers.get('settings:set')!(null, { ...settings, computerUse: false })
    expect(fake.stop).toHaveBeenCalledExactlyOnceWith('Computer use was turned off in Settings.')
    expect(fake.stop.mock.invocationCallOrder[0]!).toBeLessThan(fake.save.mock.invocationCallOrder[0]!)
  })
  it('changing the default for new chats does not interrupt another conversation', async () => {
    await fake.handlers.get('settings:set')!(null, { ...settings, defaultEngine: 'codex' })
    expect(fake.stop).not.toHaveBeenCalled()
    expect(fake.changed).not.toHaveBeenCalled()
    expect(fake.save).toHaveBeenCalledWith(expect.objectContaining({ aiSelections: { filing: { engine: 'claude', model: '' } } }))
  })

  it('does not interrupt a grant for an unrelated settings save', async () => {
    fake.load.mockResolvedValue({ ...settings, computerUse: false })
    await fake.handlers.get('settings:set')!(null, { ...settings, autoStart: true, computerUse: false })
    expect(fake.stop).not.toHaveBeenCalled()
    expect(fake.changed).not.toHaveBeenCalled()
  })
})
