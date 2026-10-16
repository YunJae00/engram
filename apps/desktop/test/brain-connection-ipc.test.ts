import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), owner: { webContents: { mainFrame: {} } }, save: vi.fn(), clear: vi.fn(), update: vi.fn(), ok: vi.fn(), broadcast: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, action: (...args: unknown[]) => unknown) => fake.handlers.set(name, action) } }))
vi.mock('core', () => ({ engineBackoff: { noteOk: vi.fn() } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopOwner: () => fake.owner }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast, markEngineOk: fake.ok }))
vi.mock('../src/main/brain-connections.js', () => ({ brainConnectionDto: vi.fn(), loadBrainConnections: vi.fn(), setBrainConnection: fake.save, clearBrainConnection: fake.clear }))
vi.mock('../src/main/settings.js', () => ({ updateSettings: fake.update }))
import { registerConnectionIpc } from '../src/main/brain-connection-ipc.js'

const sender = () => ({ sender: fake.owner.webContents, senderFrame: fake.owner.webContents.mainFrame })
const invoke = (name: string, event: unknown, ...args: unknown[]) => fake.handlers.get(`brain:${name}`)!(event, ...args)
const changed = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); fake.handlers.clear(); registerConnectionIpc(changed)
  fake.save.mockResolvedValue({ provider: 'codex', model: 'gateway-model', usable: true })
  fake.update.mockImplementation(async transform => transform({ aiSelections: { filing: { engine: 'codex', model: 'old' }, cosmos: { engine: 'claude', model: 'keep' } } }))
})

it('accepts only the main settings window and its top frame', () => {
  for (const event of [{ sender: {} }, { ...sender(), senderFrame: {} }]) expect(() => invoke('connectionSet', event, 'codex', {})).toThrow(/main window/)
  expect(fake.save).not.toHaveBeenCalled()
})

it('updates only matching model selections after a completed connection test', async () => {
  await invoke('connectionSet', sender(), 'codex', { baseUrl: 'https://example.com', key: 'test', model: 'gateway-model' })
  expect(fake.broadcast).toHaveBeenCalledWith({ type: 'settings:changed', settings: { codexModel: 'gateway-model', aiSelections: { filing: { engine: 'codex', model: 'gateway-model' }, cosmos: { engine: 'claude', model: 'keep' } } } })
  expect(fake.ok).toHaveBeenCalledWith('codex')
  expect(changed).toHaveBeenCalledWith('codex')
})

it('does not change settings or healthy state after a failed model test', async () => {
  fake.save.mockRejectedValueOnce(new Error('Model did not answer'))
  await expect(invoke('connectionSet', sender(), 'codex', {})).rejects.toThrow(/did not answer/)
  expect(fake.ok).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled()
})

it('does not let a decision model alter the conversation model or health', async () => {
  await invoke('connectionSet', sender(), 'decision', {})
  expect(fake.update).not.toHaveBeenCalled(); expect(fake.ok).not.toHaveBeenCalled()
  expect(changed).toHaveBeenCalledWith('decision')
})
