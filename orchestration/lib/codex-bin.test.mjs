import { describe, expect, it } from 'vitest'
import { resolveCodexBin } from './codex-bin.mjs'

const none = () => false
const noDirs = () => []

describe('resolveCodexBin', () => {
  it('uses an override that exists, including on another platform', () => {
    const found = resolveCodexBin('/repo', {
      platform: 'win32', arch: 'x64', override: '/opt/codex', exists: (path) => path === '/opt/codex', listDir: noDirs,
    })
    expect(found).toBe('/opt/codex')
  })

  it('skips a missing darwin override and finds the Windows vendor binary', () => {
    const darwin = 'apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
    const found = resolveCodexBin('/repo', {
      platform: 'win32', arch: 'x64', override: darwin,
      exists: (path) => path.endsWith('codex.exe') && path.includes('codex-win32-x64'),
      listDir: noDirs,
    })
    expect(found).toContain('codex-win32-x64')
    expect(found.endsWith('codex.exe')).toBe(true)
    expect(found).not.toContain('darwin')
  })

  it('finds a pnpm-stored binary for the current platform', () => {
    const found = resolveCodexBin('/repo', {
      platform: 'linux', arch: 'x64',
      exists: (path) => path.includes('@openai+codex-linux-x64@'),
      listDir: (dir) => (dir.endsWith('apps/desktop/node_modules/.pnpm') ? ['@openai+codex-linux-x64@0.155.1'] : []),
    })
    expect(found).toContain('@openai+codex-linux-x64@0.155.1')
    expect(found.endsWith('/vendor/x86_64-unknown-linux-musl/bin/codex')).toBe(true)
  })

  it('throws naming the platform and every path tried when none exist', () => {
    let message = ''
    try {
      resolveCodexBin('/repo', { platform: 'linux', arch: 'arm64', override: darwinOverride(), exists: none, listDir: noDirs })
    } catch (error) {
      message = error.message
    }
    expect(message).toMatch(/linux-arm64/)
    expect(message).toContain('codex-linux-arm64')
    expect(message).toContain('codex-darwin-arm64')
    expect(message).toContain('roles.codexBin')
  })
})

function darwinOverride() {
  return 'apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
}
