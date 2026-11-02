import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ settings: { accessibilityTrustedVersion: '' }, log: vi.fn(), load: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '0.8.101' } }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => { fake.load(); return fake.settings }, updateSettings: async (change: (s: typeof fake.settings) => typeof fake.settings) => { fake.settings = change(fake.settings) } }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.log }))
let permissionFailure: typeof import('../src/main/desktop-permission.js').permissionFailure
let rememberAccessibilityTrust: typeof import('../src/main/desktop-permission.js').rememberAccessibilityTrust
beforeEach(async () => { vi.resetModules(); ({ permissionFailure, rememberAccessibilityTrust } = await import('../src/main/desktop-permission.js')); vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin'); fake.settings = { accessibilityTrustedVersion: '' }; fake.log.mockClear(); fake.load.mockClear() })
afterEach(() => vi.restoreAllMocks())
const denial = 'Allow Engram in System Settings → Privacy & Security → Accessibility'
it('guides a previous build trust without claiming permission is repaired', async () => {
  fake.settings.accessibilityTrustedVersion = '0.8.100'
  expect((await permissionFailure(denial, 'old-build')).hint).toContain('remove Engram')
})
it('guides removal and re-addition on the first denial without duplicating escalation', async () => {
  const first = await permissionFailure(denial, 'repeat')
  expect(first.hint).toContain('remove Engram with − and add /Applications/Engram.app again with +')
  expect(first.hint).toContain('macOS ties permission to the build')
  expect((await permissionFailure(denial, 'repeat')).hint).toBe(first.hint)
  expect(fake.log.mock.calls[1]).toEqual(['desktop-permission', expect.stringContaining('"repeat":2')])
})
it('remembers only successful AX methods in existing settings', async () => {
  await rememberAccessibilityTrust('openApp')
  expect(fake.settings.accessibilityTrustedVersion).toBe('')
  await rememberAccessibilityTrust('listWindows')
  expect(fake.settings.accessibilityTrustedVersion).toBe('0.8.101')
})

it('resets accessibility denial counts after successful AX access', async () => {
  await permissionFailure(denial, 'repaired')
  await permissionFailure(denial, 'repaired')
  await rememberAccessibilityTrust('listWindows')
  expect((await permissionFailure(denial, 'repaired')).hint).toContain('allow Engram')
  await rememberAccessibilityTrust('inspectWindow')
  expect((await permissionFailure(denial, 'repaired')).hint).toContain('allow Engram')
})
it('skips settings reads after remembering the current trusted version', async () => {
  await rememberAccessibilityTrust('listWindows')
  await rememberAccessibilityTrust('inspectWindow')
  expect(fake.load).toHaveBeenCalledTimes(1)
})
