import { app } from 'electron'
import { desktopFailure, type DesktopFailureObservation } from './desktop-failure.js'
import { flog } from './flog.js'

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
export async function permissionFailure(error: unknown, lane: string, options?: Parameters<typeof desktopFailure>[1]): Promise<DesktopFailureObservation> {
  const result = desktopFailure(error, options)
  if (result.retry !== 'blocked') return result
  const { loadSettings } = await import('./settings.js')
  const appVersion = app.getVersion()
  const trustedVersion = (await loadSettings()).accessibilityTrustedVersion
  const key = `${lane}:${result.error}`
  const repeat = (denials.get(key) ?? 0) + 1
  if (!denials.has(key) && denials.size >= 512) denials.delete(denials.keys().next().value!)
  denials.set(key, repeat)
  if (result.error === 'accessibility_denied' && (repeat > 1 || trustedVersion && trustedVersion !== appVersion))
    result.hint = 'macOS may have tied the permission to a previous Engram build. In System Settings → Privacy & Security → Accessibility, remove Engram with − and add it again with +; toggling alone does not apply. Do not replace a local app read with web search; report that local access is blocked.'
  flog('desktop-permission', JSON.stringify({ code: result.error, appVersion, trustedVersion, repeat }))
  return result
}
