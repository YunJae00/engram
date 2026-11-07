import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { resolveCodexBin } from './codex-bin.mjs'

const HOST_LAYOUT = {
  'win32-x64': ['x86_64-pc-windows-msvc', 'codex.exe'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'codex.exe'],
  'darwin-x64': ['x86_64-apple-darwin', 'codex'],
  'darwin-arm64': ['aarch64-apple-darwin', 'codex'],
  'linux-x64': ['x86_64-unknown-linux-musl', 'codex'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'codex'],
}

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

  it('prefers a repo package over a codex binary on PATH', () => {
    const found = resolveCodexBin('/repo', {
      platform: 'linux', arch: 'x64', pathEnv: '/usr/local/bin', listDir: noDirs,
      exists: (path) => path.includes('codex-linux-x64') || path === join('/usr/local/bin', 'codex'),
    })
    expect(found).toContain('codex-linux-x64')
    expect(found).not.toBe(join('/usr/local/bin', 'codex'))
  })

  it('finds a PATH codex when no repo package exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-path-'))
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
    const bin = join(dir, name)
    writeFileSync(bin, '')
    chmodSync(bin, 0o755)
    try {
      const found = resolveCodexBin('/repo', {
        platform: process.platform, arch: process.arch, override: darwinOverride(),
        exists: existsSync, listDir: noDirs, pathEnv: dir,
      })
      expect(found).toBe(bin)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds a pnpm-stored binary for the host platform', () => {
    const key = `${process.platform}-${process.arch}`
    const layout = HOST_LAYOUT[key]
    expect(layout, `no codex layout for ${key}`).toBeTruthy()
    const [triple, binName] = layout
    const folder = `@openai+codex-${key}@0.155.1`
    const storeTail = join('apps', 'desktop', 'node_modules', '.pnpm')
    const found = resolveCodexBin('/repo', {
      exists: (candidate) => candidate.includes(folder),
      listDir: (dir) => (dir.endsWith(storeTail) ? [folder] : []),
    })
    expect(found).toContain(folder)
    expect(found.endsWith(join('vendor', triple, 'bin', binName))).toBe(true)
  })

  it('throws naming the platform and every path tried when none exist', () => {
    let message = ''
    try {
      resolveCodexBin('/repo', {
        platform: 'linux', arch: 'arm64', override: darwinOverride(), exists: none, listDir: noDirs, pathEnv: '/opt/bin',
      })
    } catch (error) {
      message = error.message
    }
    expect(message).toMatch(/linux-arm64/)
    expect(message).toContain('codex-linux-arm64')
    expect(message).toContain('codex-darwin-arm64')
    expect(message).toContain(join('/opt/bin', 'codex'))
    expect(message).toContain('roles.codexBin')
    expect(message).toContain('PATH')
  })
})

function darwinOverride() {
  return 'apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
}
