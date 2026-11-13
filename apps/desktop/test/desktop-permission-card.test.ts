import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
  send: vi.fn(), handle: vi.fn(), removeHandler: vi.fn(), open: vi.fn(async (url: string) => void url), ax: vi.fn((prompt: boolean) => { if (prompt) throw new Error('prompted'); return true }),
  screen: 'denied', host: { request: vi.fn() as unknown as (...args: unknown[]) => Promise<unknown> },
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.8.136' },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: fake.send } }] },
  ipcMain: { handle: fake.handle, removeHandler: fake.removeHandler },
  shell: { openExternal: fake.open },
  systemPreferences: { isTrustedAccessibilityClient: fake.ax, getMediaAccessStatus: () => fake.screen },
}))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ accessibilityTrustedVersion: '0.8.136' }), updateSettings: async () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
vi.mock('../src/main/desktop-access.js', () => ({ catalogHost: () => fake.host }))
import { forgetPermissionGiveUp, openPermissionPane, permissionCard, permissionDenied, permissionWaiting, registerPermissionCardIpc, stillOffHint, waitForPermission, type PermissionName } from '../src/main/desktop-permission-state.js'
import { permissionFailure } from '../src/main/desktop-permission.js'
import { retryOnPermission } from '../src/main/desktop-permission-retry.js'
import { PRIVACY_PANE, isAllowedExternalUrl } from '../src/main/security.js'
import { desktopFailure } from '../src/main/desktop-failure.js'
import { answerHtml } from '../src/renderer/src/markdown.js'

const LABELS = { en: { accessibility: 'Accessibility', screenRecording: 'Screen Recording', inputMonitoring: 'Input Monitoring' }, ko: { accessibility: '손쉬운 사용', screenRecording: '화면 기록', inputMonitoring: '입력 모니터링' } }
const DENIED = { accessibility: 'Accessibility', screenRecording: 'Screen Recording', inputMonitoring: 'Input Monitoring' }
const denial = (name: PermissionName) => new Error(`Allow Engram in System Settings → Privacy & Security → ${DENIED[name]}`)
const NAMES = Object.keys(DENIED) as PermissionName[]

beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin'); fake.send.mockClear(); fake.open.mockClear(); fake.ax.mockClear(); fake.screen = 'denied' })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

// The desktop agent's own retry, with its tool call passed through unchanged.
const blocked = (lane: string, error: unknown, context: { task: string; signal?: AbortSignal }, again: () => Promise<string>): Promise<string> =>
  retryOnPermission(lane, error, context, again, json => json)
const states = (screen: boolean[], rest = true) => vi.fn(async (method: string) => {
  expect(method).toBe('permissionState')
  return { accessibility: rest, inputMonitoring: rest, screenRecording: screen.length > 1 ? screen.shift()! : screen[0]! }
})
const cardsSent = () => fake.send.mock.calls.filter(call => call[0] === 'desktop:permissionCardChanged')

it('names the permission and why in the thread language', () => {
  const why = { en: ['read app windows', 'what an app window shows', 'press Esc'], ko: ['앱 창을 읽고', '앱 창에 보이는', 'Esc를 누르면'] }
  for (const lang of ['ko', 'en'] as const) NAMES.forEach((name, index) => {
    const card = permissionCard(name, lang === 'ko')
    expect(card).toMatchObject({ permission: name, lang })
    expect(card.title).toContain(LABELS[lang][name])
    expect(card.button).toContain(LABELS[lang][name])
    expect(card.why).toContain(why[lang][index])
    expect(card.why.split(/[.。]\s/)).toHaveLength(1)
    for (const other of NAMES.filter(one => one !== name)) expect(JSON.stringify(card)).not.toContain(LABELS[lang][other])
  })
  expect(permissionCard('screenRecording', true).label).toBe('켜 주시면 이어서 할게요')
  expect(permissionCard('screenRecording', false).label).toBe("I'll continue once it's on")
  expect(stillOffHint('screenRecording', true)).toContain('화면 기록')
  expect(stillOffHint('screenRecording', true)).toContain('한 문장')
  expect(stillOffHint('inputMonitoring', false)).toContain('one plain sentence that Input Monitoring is still off')
})

it('opens only the exact settings pane', async () => {
  const base = 'x-apple.systempreferences:com.apple.preference.security'
  for (const url of Object.values(PRIVACY_PANE)) expect(isAllowedExternalUrl(url)).toBe(true)
  for (const url of [`${base}?Privacy_ScreenCapture&x=1`, `${base}?Privacy_Camera`, `${base}?Privacy_AllFiles`, base, `X-APPLE.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`,
    ` ${PRIVACY_PANE.screenRecording}`, `${PRIVACY_PANE.screenRecording}#`, `${PRIVACY_PANE.screenRecording}\n`, 'https://evil.example/?Privacy_ScreenCapture']) expect(isAllowedExternalUrl(url)).toBe(false)
  await openPermissionPane('screenRecording')
  expect(fake.open.mock.calls).toEqual([[`${base}?Privacy_ScreenCapture`]])
  for (const bad of ['camera', '__proto__', 'toString', 1, undefined]) await expect(openPermissionPane(bad)).rejects.toThrow('Unknown permission')
  expect(fake.open).toHaveBeenCalledTimes(1)
  for (const name of NAMES) expect(desktopFailure(denial(name)).settingsUrl).toBe(PRIVACY_PANE[name])
  expect(desktopFailure('Read the app before acting').settingsUrl).toBeUndefined()
  for (const url of Object.values(PRIVACY_PANE)) expect(answerHtml(`[S](<${url}>)`)).toContain('target="_blank"')
  expect(answerHtml(`[S](<${base}?Privacy_Camera>)`)).not.toContain('target="_blank"')
  registerPermissionCardIpc()
  expect(fake.removeHandler.mock.invocationCallOrder[0]).toBeLessThan(fake.handle.mock.invocationCallOrder[0]!)
  const handlers = new Map(fake.handle.mock.calls.map(call => [call[0] as string, call[1] as (event: unknown, arg: unknown) => unknown]))
  expect([...handlers.keys()]).toEqual(['desktop:permissionCard', 'desktop:permissionPane'])
  const main = {}
  expect(() => handlers.get('desktop:permissionPane')!({ senderFrame: {}, sender: { mainFrame: main } }, 'screenRecording')).toThrow('main window')
  await handlers.get('desktop:permissionPane')!({ senderFrame: main, sender: { mainFrame: main } }, 'accessibility')
  expect(fake.open).toHaveBeenLastCalledWith(PRIVACY_PANE.accessibility)
  expect(handlers.get('desktop:permissionCard')!({ senderFrame: main, sender: { mainFrame: main } }, 'nobody')).toBeNull()
})

it('resumes the waiting step once the permission is on', async () => {
  vi.useFakeTimers()
  fake.host.request = states([false, false, true])
  const step = vi.fn().mockRejectedValueOnce(denial('screenRecording')).mockResolvedValueOnce('kakao window')
  const task = '카카오톡 화면 읽어 줘'
  const run = step().catch((error: unknown) => blocked('bot-a', error, { task, signal: new AbortController().signal }, step))
  await vi.advanceTimersByTimeAsync(1)
  expect(permissionWaiting('bot-a')).toBe(true)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await run).toBe('kakao window')
  expect(step).toHaveBeenCalledTimes(2)
  expect(permissionWaiting('bot-a')).toBe(false)
  expect(cardsSent()[0]).toEqual(['desktop:permissionCardChanged', 'bot-a', expect.objectContaining({ permission: 'screenRecording', lang: 'ko', title: expect.stringContaining('화면 기록') })])
  expect(cardsSent().at(-1)).toEqual(['desktop:permissionCardChanged', 'bot-a', null])
  for (const call of (fake.host.request as ReturnType<typeof vi.fn>).mock.calls) expect(call.slice(0, 2)).toEqual(['permissionState', {}])
  expect(fake.ax).not.toHaveBeenCalledWith(true)
  expect(fake.open).not.toHaveBeenCalled()
  const source = ['desktop-permission-state.ts', 'desktop-permission.ts', 'desktop-agent.ts', 'security.ts'].map(name => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')).join('\n')
  for (const call of ['CGRequestScreenCaptureAccess', 'IOHIDRequestAccess', 'kAXTrustedCheckOptionPrompt', 'tccutil']) expect(source).not.toContain(call)
  expect(permissionDenied(JSON.parse(JSON.stringify({ error: denial('screenRecording').message })).error)).toBe(true)
  expect(permissionDenied('The next target is missing')).toBe(false)

  // Never turned on: the card leaves after ten minutes and the same turn does not wait again.
  fake.send.mockClear()
  fake.host.request = states([false])
  const off = blocked('bot-b', denial('screenRecording'), { task: 'read it' }, step)
  await vi.advanceTimersByTimeAsync(10 * 60_000 + 5000)
  expect(JSON.parse(await off).hint).toBe(stillOffHint('screenRecording', false))
  expect(cardsSent().map(call => call[2] && 'card')).toEqual(['card', null])
  expect(await waitForPermission('bot-b', await permissionFailure(denial('screenRecording'), 'bot-b'), { task: 'read it' })).toBe('off')
  expect(cardsSent()).toHaveLength(2)
  // The turn's end forgets the give-up: a later turn with the same words waits and resumes again.
  forgetPermissionGiveUp('bot-b')
  fake.host.request = states([false, false, true])
  const later = waitForPermission('bot-b', await permissionFailure(denial('screenRecording'), 'bot-b'), { task: 'read it' })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await later).toBe('on')
  expect(cardsSent().map(call => call[2] && 'card')).toEqual(['card', null, 'card', null])
  fake.host.request = states([false])

  // Stop while waiting clears the card.
  fake.send.mockClear()
  const stop = new AbortController()
  const stopped = waitForPermission('bot-c', await permissionFailure(denial('screenRecording'), 'bot-c'), { task: 'x', signal: stop.signal })
  const rejected = expect(stopped).rejects.toThrow('stopped by person')
  await vi.advanceTimersByTimeAsync(3000)
  stop.abort(new Error('stopped by person'))
  await rejected
  expect(cardsSent().at(-1)).toEqual(['desktop:permissionCardChanged', 'bot-c', null])

  // Two calls share one wait, and a different permission waits its turn.
  fake.send.mockClear()
  fake.host.request = states([false, false, false, true])
  const screen = await permissionFailure(denial('screenRecording'), 'bot-d')
  const one = waitForPermission('bot-d', screen, { task: 'y' })
  const two = waitForPermission('bot-d', screen, { task: 'y' })
  const input = waitForPermission('bot-d', await permissionFailure(denial('inputMonitoring'), 'bot-d'), { task: 'y' })
  await vi.advanceTimersByTimeAsync(1)
  expect(cardsSent().filter(call => call[2])).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect([await one, await two, await input]).toEqual(['on', 'on', 'on'])
  expect(cardsSent().map(call => call[2]?.permission ?? null)).toEqual(['screenRecording', null, 'inputMonitoring', null])

  // A hung helper falls back to the no-prompt Electron read.
  fake.host.request = vi.fn((_method: string, _args: unknown, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
  const hung = waitForPermission('bot-e', await permissionFailure(denial('screenRecording'), 'bot-e'), { task: 'z' })
  await vi.advanceTimersByTimeAsync(6100)
  fake.screen = 'granted'
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await hung).toBe('on')
  expect(fake.ax).not.toHaveBeenCalledWith(true)

  // Input already sent, or not a permission: no card, no wait.
  fake.send.mockClear()
  expect(await waitForPermission('bot-f', await permissionFailure(denial('screenRecording'), 'bot-f', { delivered: true }), {})).toBe('none')
  expect(await waitForPermission('bot-f', await permissionFailure('Read the app before acting', 'bot-f'), {})).toBe('none')
  expect(cardsSent()).toHaveLength(0)
})
