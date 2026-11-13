import { systemPreferences } from 'electron'
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

const PERMISSION_READ_MS = 4000
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
