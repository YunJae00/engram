// Electron-free security policy helpers. Kept pure (no `electron` import) so the
// navigation / window.open / openExternal rules are unit-testable without
// booting a BrowserWindow — the wiring in index.ts/team.ts just calls these.
//
// Threat model: Engram is a LOCAL bundle that processes UNTRUSTED content
// (captured text, imported docs, team-synced notes, MCP tool input). None of it
// should ever be able to steer the renderer to a remote origin or hand an
// arbitrary string to the OS. These predicates are the choke points.

// Hosts we are willing to hand to the OS browser via shell.openExternal. The
// only external navigation the app performs is the one-click GitHub backup.
const EXTERNAL_HOST_ALLOWLIST = ['github.com'] as const

/**
 * True only for https URLs whose host is on the allowlist (exact host or a
 * subdomain of it). Everything else — http:, file:, data:, javascript:, a
 * bare string, an unlisted host — is refused. Used to gate every
 * shell.openExternal call and the setWindowOpenHandler external path.
 */
export function isAllowedExternalUrl(raw: string): boolean {
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

/**
 * Navigation lockdown predicate. The renderer is a local bundle and must not be
 * able to navigate itself off-origin.
 *  - dev (electron-vite dev server): allow only the dev server's own origin.
 *  - prod (loadFile): allow only file: URLs (the bundled renderer).
 * Any http(s)/data/blob/etc. target from the renderer is denied.
 */
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

/**
 * The Content-Security-Policy the main process injects on every renderer
 * response in production. The app loads only its own bundled assets plus
 * inlined data; there are no remote scripts, and all network access goes
 * through IPC to the main process, never fetch/XHR from the renderer.
 *
 *  - script-src 'self'            → only the bundled JS; blocks injected/eval'd script.
 *  - style-src ... 'unsafe-inline' → React inline styles + CodeMirror/renderer surfaces).
 *                                    inject <style> tags; unavoidable, low risk
 *                                    (no script execution from style).
 *  - img/font/media 'self' + data:/blob: → bundled fonts and any inline/blob media.
 *  - connect-src 'self'          → the renderer talks over IPC, not the network.
 *  - object/frame 'none', base-uri/form-action 'none' → no plugins, framing, or
 *                                    base-tag / form hijacking.
 */
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
