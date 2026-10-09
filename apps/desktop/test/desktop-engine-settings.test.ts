import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsDto } from '../src/shared/types.js'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, settings: Partial<AppSettingsDto>) => Promise<void>>(),
  load: vi.fn(), save: vi.fn(), stop: vi.fn(), broadcast: vi.fn(), changed: vi.fn(), cancelInterview: vi.fn(), nativeTheme: { themeSource: 'system' },
  app: { isPackaged: false, setLoginItemSettings: vi.fn() }, queue: Promise.resolve(),
}))
vi.mock('core', () => ({ createEngine: vi.fn(), ENGINE_ORDER: [], REASONING_EFFORTS: ['low', 'medium', 'high'] }))
vi.mock('electron', () => ({ app: fake.app, nativeTheme: fake.nativeTheme, dialog: {}, shell: {}, ipcMain: { handle: (name: string, handler: (event: unknown, settings: Partial<AppSettingsDto>) => Promise<void>) => fake.handlers.set(name, handler) } }))
vi.mock('../src/main/ipc.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/installer.js', () => ({ detectApiKeyEnv: vi.fn() }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fake.load, updateSettings: (change: (settings: AppSettingsDto) => AppSettingsDto) => {
  const next = fake.queue.then(async () => { const value = change(await fake.load()); await fake.save(value); return value })
  fake.queue = next.then(() => undefined, () => undefined)
  return next
} }))
vi.mock('../src/main/team.js', () => ({ getSyncStatus: vi.fn() }))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ stopDesktopControl: fake.stop }))
vi.mock('../src/main/work-interview.js', () => ({ cancelWorkInterview: fake.cancelInterview }))
import { registerSettingsIpc, setBrainChoiceHook } from '../src/main/config-ipc.js'

const settings = { defaultEngine: 'claude', autoStart: false, teamSync: 'manual', searchTemplate: '', agentBrowser: '', claudeModel: '', codexModel: '' } as AppSettingsDto
beforeEach(() => {
  vi.clearAllMocks()
  fake.handlers.clear()
  fake.queue = Promise.resolve()
  fake.app.isPackaged = false
  fake.nativeTheme.themeSource = 'system'
  fake.load.mockResolvedValue(settings)
  fake.save.mockResolvedValue(undefined)
  setBrainChoiceHook(fake.changed)
  registerSettingsIpc()
})

describe('partial settings updates', () => {
  it('preserves omitted reasoning efforts and clears explicitly undefined efforts', async () => {
    fake.load.mockResolvedValue({ ...settings, claudeEffort: 'high', codexEffort: 'medium' })
    const save = fake.handlers.get('settings:set')!
    await save(null, { theme: 'dark' })
    expect(fake.save).toHaveBeenLastCalledWith(expect.objectContaining({ claudeEffort: 'high', codexEffort: 'medium' }))
    await save(null, { claudeEffort: undefined, codexEffort: undefined })
    expect(fake.save).toHaveBeenLastCalledWith(expect.objectContaining({ claudeEffort: undefined, codexEffort: undefined }))
    expect(JSON.stringify(fake.save.mock.lastCall![0])).not.toMatch(/claudeEffort|codexEffort/)
  })

  it('preserves newer settings from the write queue rather than restoring the earlier read', async () => {
    fake.load.mockResolvedValueOnce({ ...settings, computerUse: true, searchTemplate: 'old', claudeModel: 'old' })
      .mockResolvedValue({ ...settings, computerUse: false, searchTemplate: 'new', claudeModel: 'new' })
    await fake.handlers.get('settings:set')!(null, { theme: 'dark', searchTemplate: undefined })
    expect(fake.save).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark', computerUse: false, searchTemplate: 'new', claudeModel: 'new' }))
    expect(fake.stop).not.toHaveBeenCalled()
  })

  it('merges simultaneous privacy and appearance updates without restoring withdrawn permissions', async () => {
    let current = { ...settings, computerUse: true, workMap: true, theme: 'light' } as AppSettingsDto
    fake.load.mockImplementation(async () => current)
    fake.save.mockImplementation(async (next: AppSettingsDto) => { current = next })
    const save = fake.handlers.get('settings:set')!
    await Promise.all([save(null, { computerUse: false }), save(null, { workMap: false }), save(null, { theme: 'dark' })])
    expect(current).toEqual(expect.objectContaining({ computerUse: false, workMap: false, theme: 'dark' }))
    expect(fake.stop).toHaveBeenCalledOnce()
    expect(fake.cancelInterview).toHaveBeenCalledOnce()
  })

  it('does not change native appearance or login settings for an unrelated update', async () => {
    fake.app.isPackaged = true
    fake.nativeTheme.themeSource = 'dark'
    fake.load.mockResolvedValue({ ...settings, theme: 'light' })
    await fake.handlers.get('settings:set')!(null, { workMap: false })
    expect(fake.nativeTheme.themeSource).toBe('dark')
    expect(fake.app.setLoginItemSettings).not.toHaveBeenCalled()
    await fake.handlers.get('settings:set')!(null, { autoStart: true })
    expect(fake.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true })
  })

  it('rejects malformed partial updates before saving or changing permissions', async () => {
    for (const value of [null, [], 'dark', { defaultEngine: 'invalid' }, { theme: null }, { autoStart: 1 }, { computerUse: 'yes' }, { workMap: null }, { claudeModel: [] }, { agentBrowser: 42 }, { teamSync: 'invalid' }]) {
      await expect(fake.handlers.get('settings:set')!(null, value as Partial<AppSettingsDto>)).rejects.toThrow('Invalid')
    }
    expect(fake.save).not.toHaveBeenCalled()
    expect(fake.stop).not.toHaveBeenCalled()
  })
})

it('ignores the removed recording preference from an older settings client', async () => {
  await fake.handlers.get('settings:set')!(null, { theme: 'dark', recordTasks: true } as Partial<AppSettingsDto>)
  expect(fake.save).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
  expect(fake.save.mock.lastCall![0]).not.toHaveProperty('recordTasks')
})

describe('desktop grant lifetime when choosing an AI connection', () => {
  it('stops prepared map context before persisting withdrawal of work-map consent', async () => {
    fake.load.mockResolvedValue({ ...settings, workMap: true })
    await fake.handlers.get('settings:set')!(null, { ...settings, workMap: false })
    expect(fake.cancelInterview).toHaveBeenCalledOnce()
    expect(fake.cancelInterview.mock.invocationCallOrder[0]!).toBeLessThan(fake.save.mock.invocationCallOrder[0]!)
    fake.cancelInterview.mockClear()
    fake.load.mockResolvedValue({ ...settings, workMap: false })
    await fake.handlers.get('settings:set')!(null, { ...settings, workMap: false, autoStart: true })
    expect(fake.cancelInterview).not.toHaveBeenCalled()
  })
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
