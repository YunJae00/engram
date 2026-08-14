import { describe, expect, it } from 'vitest'
import { allowNavigation, isAllowedExternalUrl, RENDERER_CSP } from '../src/main/security.js'

// These lock the Electron navigation / openExternal / CSP hardening. They are
// pure predicates on purpose so the policy is provable without a BrowserWindow.

describe('isAllowedExternalUrl (shell.openExternal gate)', () => {
  it('allows https github.com and its subdomains', () => {
    expect(isAllowedExternalUrl('https://github.com/new?name=x&visibility=private')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/you/repo.git')).toBe(true)
    expect(isAllowedExternalUrl('https://gist.github.com/you/abc')).toBe(true)
  })

  it('refuses non-https schemes even for an allowed host', () => {
    expect(isAllowedExternalUrl('http://github.com/new')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<script>1</script>')).toBe(false)
  })

  it('refuses off-allowlist hosts and lookalikes', () => {
    expect(isAllowedExternalUrl('https://evil.com')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com.evil.com')).toBe(false)
    expect(isAllowedExternalUrl('https://notgithub.com')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
  })
})

describe('allowNavigation (will-navigate / will-redirect gate)', () => {
  it('production: only file: URLs (the bundled renderer) may be navigated to', () => {
    expect(allowNavigation('file:///C:/app/renderer/index.html', undefined)).toBe(true)
    expect(allowNavigation('file:///C:/app/renderer/index.html#quick', undefined)).toBe(true)
    expect(allowNavigation('https://evil.com', undefined)).toBe(false)
    expect(allowNavigation('http://localhost:5173', undefined)).toBe(false)
    expect(allowNavigation('data:text/html,x', undefined)).toBe(false)
    expect(allowNavigation('garbage', undefined)).toBe(false)
  })

  it('dev: only the dev server origin is allowed, everything else denied', () => {
    const dev = 'http://localhost:5173'
    expect(allowNavigation('http://localhost:5173/index.html', dev)).toBe(true)
    expect(allowNavigation('http://localhost:5173/#quick', dev)).toBe(true)
    expect(allowNavigation('http://localhost:9999', dev)).toBe(false)
    expect(allowNavigation('https://github.com', dev)).toBe(false)
    expect(allowNavigation('file:///C:/app/index.html', dev)).toBe(false)
  })
})

describe('RENDERER_CSP', () => {
  it('scopes scripts to self and forbids plugins / base / form hijacking', () => {
    expect(RENDERER_CSP).toContain("script-src 'self'")
    expect(RENDERER_CSP).toContain("default-src 'self'")
    expect(RENDERER_CSP).toContain("object-src 'none'")
    expect(RENDERER_CSP).toContain("base-uri 'none'")
    expect(RENDERER_CSP).toContain("form-action 'none'")
    // no remote script/eval escape hatch
    expect(RENDERER_CSP).not.toContain('unsafe-eval')
    expect(RENDERER_CSP).not.toContain('http://')
    expect(RENDERER_CSP).not.toContain('https://')
  })
})
