import { app } from 'electron'
import { desktopFailure, type DesktopFailureObservation } from './desktop-failure.js'
import { flog } from './flog.js'
import { CODE_PERMISSION, korean, permissionGuidance, stillOffHint, waitForPermission, type PermissionCode, type PermissionName } from './desktop-permission-state.js'

const denials = new Map<string, number>()
let trustedVersion: string | undefined
const AX_METHODS = new Set(['listWindows', 'inspectWindow', 'activateWindow', 'observe', 'capture', 'prepare', 'bind', 'quietState', 'quietScan', 'quietRead', 'quietSet', 'quietPress', 'documentRead', 'documentEdit', 'documentCompose'])
export async function rememberAccessibilityTrust(method: string): Promise<void> {
  if (process.platform !== 'darwin' || !AX_METHODS.has(method)) return
  for (const key of denials.keys()) if (key.endsWith(':accessibility_denied')) denials.delete(key)
  const version = app.getVersion()
  if (trustedVersion === version) return
  const { loadSettings, updateSettings } = await import('./settings.js')
  if ((await loadSettings()).accessibilityTrustedVersion !== version)
    await updateSettings(settings => ({ ...settings, accessibilityTrustedVersion: version }))
  trustedVersion = version
}
export async function permissionFailure(error: unknown, lane: string, options: Parameters<typeof desktopFailure>[1] & { ask?: string } = {}): Promise<DesktopFailureObservation & { permission?: PermissionName }> {
  const { ask, ...failure } = options
  const result = desktopFailure(error, failure)
  if (result.retry !== 'blocked') return result
  const { loadSettings } = await import('./settings.js')
  const appVersion = app.getVersion()
  const trustedVersion = (await loadSettings()).accessibilityTrustedVersion
  const key = `${lane}:${result.error}`
  const repeat = (denials.get(key) ?? 0) + 1
  if (!denials.has(key) && denials.size >= 512) denials.delete(denials.keys().next().value!)
  denials.set(key, repeat)
  flog('desktop-permission', JSON.stringify({ code: result.error, appVersion, trustedVersion, repeat }))
  if (!(result.error in CODE_PERMISSION)) return result
  const code = result.error as PermissionCode
  return { ...result, permission: CODE_PERMISSION[code], ...(korean(ask) ? { hint: `${permissionGuidance(code, true)} 로컬 앱 읽기를 웹 검색으로 대신하지 말고, 접근이 막혔다고 알려 주세요.` } : {}) }
}
// A denied permission shows a card, waits for it to turn on, then runs the call once more.
export async function retryOnPermission<T>(lane: string, error: unknown, context: { task?: string; signal?: AbortSignal }, again: () => Promise<T>, wrap: (json: string) => T): Promise<T> {
  context.signal?.throwIfAborted()
  const failure = await permissionFailure(error, lane, { ask: context.task })
  const waited = await waitForPermission(lane, failure, context)
  if (waited === 'on') {
    try { return await again() }
    catch (retry) { context.signal?.throwIfAborted(); return wrap(JSON.stringify(await permissionFailure(retry, lane, { ask: context.task }))) }
  }
  return wrap(JSON.stringify(waited === 'off' ? { ...failure, hint: stillOffHint(failure.permission!, korean(context.task)) } : failure))
}
