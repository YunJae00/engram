import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ ax: false, screen: 'denied', host: undefined as unknown }))
vi.mock('electron', () => ({ app: { getVersion: () => '0.8.101' }, systemPreferences: { isTrustedAccessibilityClient: (prompt: boolean) => prompt ? (() => { throw new Error('prompted') })() : fake.ax, getMediaAccessStatus: () => fake.screen } }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ accessibilityTrustedVersion: '0.8.101' }), updateSettings: async () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
vi.mock('../src/main/desktop-access.js', () => ({ catalogHost: () => fake.host }))
import { permissionStateTool, readPermissionState } from '../src/main/desktop-permission-state.js'
import { desktopOptIn } from '../src/main/desktop-opt-in.js'
import { permissionFailure } from '../src/main/desktop-permission.js'

beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin'); fake.ax = false; fake.screen = 'denied' })
afterEach(() => vi.restoreAllMocks())
const host = (result: unknown) => ({ request: vi.fn(async () => result) as never })

it('reports each permission without prompting', async () => {
  const one = host({ accessibility: true, screenRecording: false, inputMonitoring: false, extra: 1 })
  expect(await readPermissionState(one)).toEqual({ accessibility: true, screenRecording: false, inputMonitoring: false })
  expect((one.request as ReturnType<typeof vi.fn>).mock.calls).toEqual([['permissionState', {}, undefined]])
  await expect(readPermissionState(host({ accessibility: 'yes' }))).rejects.toThrow('could not read')
  await expect(readPermissionState(host([true, true, true]))).rejects.toThrow('could not read')
  const native = ['Permissions.swift', 'Host.swift', 'InputMonitor.swift', 'Main.swift'].map(name => readFileSync(new URL(`../native/macos/${name}`, import.meta.url), 'utf8')).join('\n')
  for (const call of ['CGRequestScreenCaptureAccess', 'IOHIDRequestAccess', 'kAXTrustedCheckOptionPrompt', 'AXIsProcessTrustedWithOptions', 'tccutil', 'x-apple.systempreferences']) expect(native).not.toContain(call)
  for (const call of ['AXIsProcessTrusted()', 'CGPreflightScreenCaptureAccess()', 'IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)']) expect(native).toContain(call)
  expect(readFileSync(new URL('../native/macos/InputMonitor.swift', import.meta.url), 'utf8')).toContain('IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)')
})

it('names the missing permission in its guidance', async () => {
  const screen = await permissionFailure('Allow Engram in System Settings → Privacy & Security → Screen Recording', 'a', { ask: '카톡 화면 보여 줘' })
  expect(screen).toMatchObject({ error: 'screen_recording_denied', permission: 'screenRecording', retry: 'blocked' })
  expect(screen.hint).toContain('화면 기록')
  expect(screen.hint).not.toMatch(/손쉬운 사용|입력 모니터링/)
  const input = await permissionFailure('Allow Engram in System Settings → Privacy & Security → Input Monitoring', 'b', { ask: 'click send in Slack' })
  expect(input).toMatchObject({ error: 'input_monitoring_denied', permission: 'inputMonitoring' })
  expect(input.hint).toContain('Input Monitoring')
  const ax = await permissionFailure('Allow Engram in System Settings → Privacy & Security → Accessibility', 'c', { ask: '메모 앱 읽어 줘', delivered: true })
  expect(ax).toMatchObject({ error: 'accessibility_denied', permission: 'accessibility', delivery: 'delivered_unverified' })
  expect(ax.hint).toContain('손쉬운 사용')
  expect(ax.hint).toContain('/Applications/Engram.app')
  expect((await permissionFailure('Read the app before acting', 'd', { ask: '읽어 줘' })).permission).toBeUndefined()
})

it('a bot can read the permission state', async () => {
  const fakeHost = host({ accessibility: true, screenRecording: false, inputMonitoring: false })
  const tool = permissionStateTool(() => fakeHost)
  expect(tool.name).toBe('permission_state')
  const ko = await tool.run({}, { task: '권한 뭐 켜져 있어?' })
  for (const line of ['손쉬운 사용: 켜짐', '화면 기록: 꺼짐', '입력 모니터링: 꺼짐', '앱 창을 읽고', '스크린샷', 'Esc를 누르면', '직접 바꾸지 않습니다']) expect(ko).toContain(line)
  const en = await tool.run({}, { task: 'what permissions does Engram have?' })
  for (const line of ['Accessibility: on', 'Screen Recording: off', 'Input Monitoring: off', 'read app windows', 'screenshots', 'press Esc']) expect(en).toContain(line)
  const calls = (fakeHost.request as ReturnType<typeof vi.fn>).mock.calls
  expect(calls).toHaveLength(2)
  for (const call of calls) expect(call).toEqual(['permissionState', {}, expect.any(AbortSignal)])
})

it('first turn shows the real input monitoring state', async () => {
  vi.resetModules()
  const fresh = await import('../src/main/desktop-permission-state.js')
  const slow = { request: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ accessibility: false, screenRecording: true, inputMonitoring: true }), 30))) as never }
  const tool = fresh.permissionStateTool(() => slow)
  expect(tool.description).not.toMatch(/not checked|확인 안 됨/)
  const answer = await tool.run({}, { task: 'what permissions does Engram have?' })
  for (const line of ['Accessibility: off', 'Screen Recording: on', 'Input Monitoring: on']) expect(answer).toContain(line)
  expect(answer).not.toContain('not checked yet')

  vi.resetModules()
  const silent = await import('../src/main/desktop-permission-state.js')
  const hung = { request: vi.fn((_m: string, _a: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))) as never }
  expect(await silent.permissionStateTool(() => hung).run({}, { task: 'what permissions does Engram have?' })).toContain('Input Monitoring: not checked yet')
}, 10_000)

it('permission read needs no app-control consent', async () => {
  fake.host = host({ accessibility: true, screenRecording: false, inputMonitoring: false })
  const consent = { enabled: vi.fn(async () => false), enable: vi.fn(async () => undefined), ask: vi.fn(async () => 'cancel' as const) }
  const listRun = vi.fn(async () => '[]')
  const tools = desktopOptIn([{ name: 'list_apps', description: 'List app launchers.', argsSchema: {}, run: listRun }], consent)
  const read = tools.find(tool => tool.name === 'permission_state')!
  const ko = await read.run({}, { task: '권한 뭐 켜져 있어?' })
  for (const line of ['손쉬운 사용: 켜짐', '화면 기록: 꺼짐', '입력 모니터링: 꺼짐']) expect(ko).toContain(line)
  expect(consent.ask).not.toHaveBeenCalled(); expect(consent.enable).not.toHaveBeenCalled(); expect(consent.enabled).not.toHaveBeenCalled()
  expect(listRun).not.toHaveBeenCalled()
  await expect(tools.find(tool => tool.name === 'list_apps')!.run({}, { task: 'list apps' })).rejects.toThrow('not approved')
  expect(desktopOptIn([{ name: 'read_desktop', description: 'Read app', argsSchema: {}, run: vi.fn() }], consent).some(tool => tool.name === 'permission_state')).toBe(false)
})
