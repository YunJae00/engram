import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron'
import { PRIVACY_PANE, isAllowedExternalUrl } from './security.js'
import { desktopFailure, type DesktopFailureObservation } from './desktop-failure.js'
import type { PermissionCardDto } from '../shared/types.js'
import type { AgentTool } from 'core'
import type { DesktopHost } from './desktop-host.js'
import { PERMISSION_STATE_DESCRIPTION } from './desktop-opt-in.js'

export type PermissionName = 'accessibility' | 'screenRecording' | 'inputMonitoring'
export type PermissionState = Record<PermissionName, boolean>
type KnownState = Record<PermissionName, boolean | undefined>
const ORDER: PermissionName[] = ['accessibility', 'screenRecording', 'inputMonitoring']
const LABEL = {
  en: { accessibility: 'Accessibility', screenRecording: 'Screen Recording', inputMonitoring: 'Input Monitoring' },
  ko: { accessibility: '손쉬운 사용', screenRecording: '화면 기록', inputMonitoring: '입력 모니터링' },
}
const NEED = {
  en: {
    accessibility: 'needed to read app windows and press, set or type in their controls',
    screenRecording: 'needed to take screenshots of app windows for look_desktop and the preview card',
    inputMonitoring: 'needed to take the keyboard and mouse; Engram watches your input so it stops when you move or press Esc',
  },
  ko: {
    accessibility: '앱 창을 읽고 버튼을 누르거나 글자를 넣을 때 필요합니다',
    screenRecording: '앱 창 스크린샷과 미리보기 카드에 필요합니다',
    inputMonitoring: '키보드·마우스로 직접 조작할 때 필요합니다. 사람이 움직이거나 Esc를 누르면 바로 멈추려고 입력을 지켜봅니다',
  },
}
export const CODE_PERMISSION = { accessibility_denied: 'accessibility', screen_recording_denied: 'screenRecording', input_monitoring_denied: 'inputMonitoring' } as const
export type PermissionCode = keyof typeof CODE_PERMISSION
export const korean = (text: string | undefined): boolean => /[가-힣]/.test(text ?? '')

let lastRead: PermissionState | undefined
const PERMISSION_READ_MS = 4000
export async function readPermissionState(host: Pick<DesktopHost, 'request'>, signal?: AbortSignal): Promise<PermissionState> {
  const value = await host.request<unknown>('permissionState', {}, signal)
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object' || Array.isArray(record) || !ORDER.every(name => typeof record[name] === 'boolean'))
    throw new Error('Engram could not read its macOS permissions.')
  lastRead = { accessibility: record.accessibility as boolean, screenRecording: record.screenRecording as boolean, inputMonitoring: record.inputMonitoring as boolean }
  return lastRead
}

export function describePermissionState(state: KnownState, ko: boolean): string {
  const lang = ko ? 'ko' : 'en'
  const word = (on: boolean | undefined) => on === undefined ? (ko ? '아직 확인 안 됨' : 'not checked yet') : on ? (ko ? '켜짐' : 'on') : (ko ? '꺼짐' : 'off')
  const lines = ORDER.map(name => `${LABEL[lang][name]}: ${word(state[name])} — ${NEED[lang][name]}`)
  if (ORDER.some(name => state[name] === false)) lines.push(ko ? '시스템 설정 → 개인정보 보호 및 보안에서 켤 수 있습니다. Engram은 이 설정을 직접 바꾸지 않습니다.'
    : 'Turn it on in System Settings → Privacy & Security; Engram never changes these settings itself.')
  return lines.join('\n')
}

export function permissionGuidance(code: PermissionCode, ko: boolean): string {
  const name = CODE_PERMISSION[code]
  if (!ko) return `Engram does not have ${LABEL.en[name]}. Ask the person to allow Engram in System Settings → Privacy & Security → ${LABEL.en[name]}; it is ${NEED.en[name]}.`
  const label = LABEL.ko[name]
  return `Engram에 '${label}' 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → ${label}에서 Engram을 켜 달라고 요청하세요. ${NEED.ko[name]}.`
    + (name === 'accessibility' ? ' 이미 켜져 있으면 −로 지운 뒤 +로 /Applications/Engram.app을 다시 추가하세요(macOS는 권한을 빌드마다 따로 기억합니다).' : '')
}

// Fallback when the helper does not answer: Electron's no-prompt reads plus the helper's last Input Monitoring answer.
export function permissionStateNow(): KnownState {
  const read = <T>(get: () => T): T | undefined => { try { return get() } catch { return undefined } }
  return {
    accessibility: read(() => systemPreferences.isTrustedAccessibilityClient(false)) ?? lastRead?.accessibility,
    screenRecording: read(() => systemPreferences.getMediaAccessStatus('screen') === 'granted') ?? lastRead?.screenRecording,
    inputMonitoring: lastRead?.inputMonitoring,
  }
}

export function permissionStateTool(host: () => Pick<DesktopHost, 'request'>): AgentTool {
  return {
    name: 'permission_state',
    description: PERMISSION_STATE_DESCRIPTION,
    argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, context) {
      const timeout = AbortSignal.timeout(PERMISSION_READ_MS)
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
      const state = await (async () => readPermissionState(host(), signal))().catch(() => { context.signal?.throwIfAborted(); return undefined })
      return describePermissionState(state ?? permissionStateNow(), korean(context.task))
    },
  }
}

const WHY = {
  en: {
    accessibility: 'Needed to read app windows and press or type in them.',
    screenRecording: 'Needed to see what an app window shows, like a chat.',
    inputMonitoring: 'Needed to stop at once when you move the mouse or press Esc.',
  },
  ko: {
    accessibility: '앱 창을 읽고 누르거나 입력하려면 필요해요.',
    screenRecording: '채팅처럼 앱 창에 보이는 내용을 보려면 필요해요.',
    inputMonitoring: '마우스를 움직이거나 Esc를 누르면 바로 멈추려면 필요해요.',
  },
}
export function permissionCard(name: PermissionName, ko: boolean): PermissionCardDto {
  const label = LABEL[ko ? 'ko' : 'en'][name]
  return ko
    ? { permission: name, lang: 'ko', label: '켜 주시면 이어서 할게요', title: `'${label}' 권한이 꺼져 있어요`, why: WHY.ko[name], button: `${label} 설정 열기` }
    : { permission: name, lang: 'en', label: "I'll continue once it's on", title: `${label} is off`, why: WHY.en[name], button: `Open ${label} settings` }
}
export function stillOffHint(name: PermissionName, ko: boolean): string {
  const label = LABEL[ko ? 'ko' : 'en'][name]
  return ko ? `'${label}' 권한이 아직 꺼져 있어 이 단계를 멈췄습니다. '${label}' 권한이 아직 꺼져 있다고 한 문장으로 알리고 이번 턴을 끝내세요.`
    : `${label} is still off, so this step stopped. Tell the person in one plain sentence that ${label} is still off, and end the turn.`
}
export function permissionDenied(error: unknown): boolean {
  const failure = desktopFailure(error)
  return failure.retry === 'blocked' && failure.error in CODE_PERMISSION
}

const cards = new Map<string, PermissionCardDto>()
function setCard(lane: string, card: PermissionCardDto | null): void {
  if (card) cards.set(lane, card); else cards.delete(lane)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:permissionCardChanged', lane, card)
}
export async function openPermissionPane(name: unknown): Promise<void> {
  const url = typeof name === 'string' && Object.hasOwn(PRIVACY_PANE, name) ? PRIVACY_PANE[name as PermissionName] : undefined
  if (!url || !isAllowedExternalUrl(url)) throw new Error('Unknown permission.')
  await shell.openExternal(url)
}
export function registerPermissionCardIpc(): void {
  const handle = (channel: string, run: (arg: unknown) => unknown) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, arg: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Only the main window can do this.')
      return run(arg)
    })
  }
  handle('desktop:permissionCard', lane => typeof lane === 'string' ? cards.get(lane) ?? null : null)
  handle('desktop:permissionPane', openPermissionPane)
  if (testing()) Object.assign(globalThis, { __engramPermissionWait: (lane: string, name: PermissionName, task: string) =>
    waitForPermission(lane, { ...desktopFailure(`Allow Engram in System Settings → ${LABEL.en[name]}`), permission: name }, { task }) })
}
// E2E seam, never in a packaged build: the permission state comes from main's globalThis instead of the helper.
const testing = () => !app.isPackaged && process.env['ENGRAM_TEST_PERMISSIONS'] === '1'
const WAIT_MS = 10 * 60_000, FIRST_MS = 2000, MAX_MS = 5000
const waits = new Map<string, { name: PermissionName; done: Promise<boolean> }>()
// Each tool call gets its own signal, so a give-up is remembered per lane and task text: the same turn does not wait twice.
const gaveUp = new Map<string, string>()
// The tool budget pauses while the person is asked to turn a permission on.
export const permissionWaiting = (lane: string): boolean => waits.has(lane)
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const stop = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}
async function isOn(name: PermissionName, signal?: AbortSignal): Promise<boolean> {
  if (testing()) return (globalThis as { __engramPermissionState?: Partial<PermissionState> }).__engramPermissionState?.[name] === true
  const timeout = AbortSignal.timeout(PERMISSION_READ_MS)
  const host = (await import('./desktop-access.js')).catalogHost()
  const state: KnownState = await readPermissionState(host, signal ? AbortSignal.any([signal, timeout]) : timeout)
    .catch(() => { signal?.throwIfAborted(); return permissionStateNow() })
  return state[name] === true
}
async function poll(name: PermissionName, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS
  for (let delay = FIRST_MS; Date.now() < deadline; delay = Math.min(MAX_MS, delay * 1.5)) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal)
    if (await isOn(name, signal)) return true
  }
  return false
}
export async function waitForPermission(lane: string, failure: DesktopFailureObservation & { permission?: PermissionName }, context: { task?: string; signal?: AbortSignal }): Promise<'none' | 'on' | 'off'> {
  const name = failure.permission
  if (!name || failure.delivery !== 'not_delivered' || process.platform !== 'darwin') return 'none'
  const { signal } = context
  const turn = `${name}\n${context.task ?? ''}`
  if (gaveUp.get(lane) === turn) return 'off'
  let current = waits.get(lane)
  while (current && current.name !== name) {
    await current.done.catch(() => false)
    signal?.throwIfAborted()
    current = waits.get(lane)
  }
  let on: boolean
  if (current) { on = await current.done; signal?.throwIfAborted() }
  else {
    setCard(lane, permissionCard(name, korean(context.task)))
    const entry = { name, done: poll(name, signal) }
    waits.set(lane, entry)
    try { on = await entry.done }
    finally {
      if (waits.get(lane) === entry) waits.delete(lane)
      if (cards.get(lane)?.permission === name) setCard(lane, null)
    }
  }
  if (on) { gaveUp.delete(lane); return 'on' }
  gaveUp.set(lane, turn)
  return 'off'
}
