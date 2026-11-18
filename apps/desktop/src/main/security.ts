import { PRIVACY_PANE } from './desktop-failure.js'
export { PRIVACY_PANE }

const EXTERNAL_HOST_ALLOWLIST = ['github.com'] as const

export function isAllowedExternalUrl(raw: string): boolean {
  if ((Object.values(PRIVACY_PANE) as string[]).includes(raw)) return true
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return EXTERNAL_HOST_ALLOWLIST.some((h) => host === h || host.endsWith(`.${h}`))
}

export function allowNavigation(targetUrl: string, devServerUrl: string | undefined): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (devServerUrl) {
    try {
      return target.origin === new URL(devServerUrl).origin
    } catch {
      return false
    }
  }
  return target.protocol === 'file:'
}

export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')
